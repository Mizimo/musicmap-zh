#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { verifyRelease } from '../scripts/package-release.mjs';
import { shardForText, validateShardWrapper } from '../scripts/translate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = async (rootDir, path) => JSON.parse(await readFile(resolve(rootDir, path), 'utf8'));

export async function verifyFullShards(rootDir, source, sourceHash, simplified) {
  const all = new Set();
  const shards = [];
  for (let index = 1; index <= 8; index += 1) {
    const wrapper = await readJson(rootDir, `generated/shards/zh-Hans-${index}-of-8.json`);
    validateShardWrapper(wrapper, { sourceHash, source, language: 'zh-Hans', shard: { index, count: 8 } });
    const assigned = source.filter((text) => shardForText(text, 8) === index);
    assert.equal(Object.keys(wrapper.translations).length, assigned.length, `Shard ${index} is incomplete.`);
    for (const text of assigned) {
      assert.equal(typeof wrapper.translations[text], 'string');
      assert.ok(wrapper.translations[text].trim());
      assert.equal(wrapper.translations[text], simplified[text], `Shard ${index} differs from the final reviewed Simplified Chinese locale.`);
      assert.equal(all.has(text), false, 'Duplicate source across shards.');
      all.add(text);
    }
    shards.push({ index, translated: assigned.length, complete: true });
  }
  assert.equal(all.size, source.length);
  return { sourceHash, total: all.size, shards };
}

async function installInspectionHelpers(page, genres, locales) {
  return page.evaluate(({ genres, locales }) => {
    const normalize = (text) => text.replace(/\s+/g, ' ').trim();
    function textNodes(root) {
      const values = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) values.push(walker.currentNode);
      return values;
    }
    function snapshot(root) {
      if (!root) return null;
      const copy = root.cloneNode(true);
      copy.querySelectorAll('[data-mmzh-original]').forEach((node) => node.remove());
      return {
        texts: textNodes(copy).map((node) => node.nodeValue),
        elements: [...copy.querySelectorAll('*')].map((node) => ({ tag: node.tagName.toLowerCase(),
          attributes: [...node.attributes].filter((attribute) => ['data-code', 'href', 'class', 'id', 'target', 'rel'].includes(attribute.name)).map((attribute) => [attribute.name, attribute.value]).sort(([a], [b]) => a.localeCompare(b)),
        })),
      };
    }
    function expected(markup, language) {
      const root = document.createElement('div');
      root.innerHTML = markup ?? '';
      if (language !== 'en') for (const node of textNodes(root)) {
        if (node.parentElement.closest('script,style,noscript,iframe,textarea,.song-title,#people-list')) continue;
        const original = node.nodeValue.trim();
        if (!/[a-zA-Z]{2}/.test(node.nodeValue) || original.length <= 1) continue;
        const translation = locales[language][normalize(original)];
        if (typeof translation === 'string' && translation) node.nodeValue = node.nodeValue.replace(original, () => translation);
      }
      return snapshot(root);
    }
    const byCode = {};
    const boundaries = [];
    const plain = (markup) => { const root = document.createElement('div'); root.innerHTML = markup ?? ''; return root.textContent; };
    for (const [code, entry] of Object.entries(genres)) {
      const family = Array.isArray(entry.genrelist);
      const descriptionSelector = family ? '#supergenre-side-pane-genre-description' : '#right-side-pane-genre-description';
      const titleSelector = family ? '#supergenre-side-pane-genre-name' : '#right-side-pane-genre-name';
      const raw = document.createElement('div'); raw.innerHTML = entry.description;
      textNodes(raw).forEach((node, index) => {
        const key = normalize(node.nodeValue);
        if (/[a-zA-Z]/.test(key) && !Object.hasOwn(locales['zh-Hans'], key)) boundaries.push({ code, textNode: index, sourceText: node.nodeValue, normalizedText: key,
          excludedByReader: !/[a-zA-Z]{2}/.test(node.nodeValue) || key.length <= 1,
          note: 'Source extraction boundary; not counted as evidence that no English remains.' });
      });
      byCode[code] = { family, name: normalize(plain(entry.name)), descriptionSelector, titleSelector,
        expected: Object.fromEntries(['zh-Hans', 'zh-Hant', 'en'].map((language) => [language, {
          title: expected(entry.name, language), description: expected(entry.description, language),
          firstTag: expected(entry['supergenre-first-tag'], language), secondTag: expected(entry['supergenre-second-tag']?.[1], language),
        }])),
        songs: (entry.songlist ?? []).map(plain),
        familyLinks: (entry.genrelist ?? []).flatMap((markup) => { const root = document.createElement('div'); root.innerHTML = markup; return [...root.querySelectorAll('a[data-code]')].map((node) => ({ code: node.getAttribute('data-code'), href: node.getAttribute('href') })); }),
        playlist: entry['playlist-link'], spotify: entry['spotify-playlist-link'],
      };
    }
    const navigation = [...new Set([...document.querySelectorAll('#main-genres text[data-code],#supergenres-list [data-code]')].map((node) => node.dataset.code))];
    const missing = Object.keys(genres).filter((code) => !navigation.includes(code));
    const unknown = navigation.filter((code) => !Object.hasOwn(genres, code));
    window.__musicmapCompleteAudit = {
      byCode, snapshot,
      inspect(code, language) {
        const entry = byCode[code];
        const actual = { title: snapshot(document.querySelector(entry.titleSelector)), description: snapshot(document.querySelector(entry.descriptionSelector)) };
        if (!entry.family) {
          actual.firstTag = snapshot(document.querySelector('#right-side-pane-supergenre-first-tag'));
          actual.secondTag = snapshot(document.querySelector('#right-side-pane-supergenre-second-tag'));
        }
        const expected = entry.expected[language];
        const mismatches = Object.keys(actual).filter((part) => JSON.stringify(actual[part]) !== JSON.stringify(expected[part]));
        const links = entry.family ? [...document.querySelectorAll('.supergenre-side-pane-genre-list a[data-code]')].map((node) => ({ code: node.getAttribute('data-code'), href: node.getAttribute('href') })) : [];
        const songs = entry.family ? [] : [...document.querySelectorAll('#right-side-pane-songlist > li > a')].map((node) => node.textContent);
        if (entry.family && JSON.stringify(links) !== JSON.stringify(entry.familyLinks)) mismatches.push('familyLinks');
        if (!entry.family && JSON.stringify(songs) !== JSON.stringify(entry.songs)) mismatches.push('songNames');
        if (!entry.family && document.querySelector('#right-side-pane-go-to-link')?.getAttribute('data-code') !== code) mismatches.push('selectedCode');
        if (!entry.family && document.querySelector('#youtube-playlist-link')?.getAttribute('href') !== entry.playlist) mismatches.push('youtubeLink');
        if (!entry.family && document.querySelector('#spotify-playlist-link')?.getAttribute('href') !== entry.spotify) mismatches.push('spotifyLink');
        return { code, language, mismatches, descriptionTextNodes: actual.description?.texts.length ?? 0,
          descriptionCharacters: actual.description?.texts.join('').length ?? 0, songs: songs.length,
          internalLinks: entry.family ? links.length : [...document.querySelectorAll('#right-side-pane-supergenre-first-tag a[data-code],#right-side-pane-supergenre-second-tag a[data-code]')].length,
          ...(mismatches.length ? { actual, expected } : {}),
        };
      },
    };
    return { navigation, missing, unknown, sourceBoundaries: boundaries,
      families: Object.values(byCode).filter((entry) => entry.family).length,
      genres: Object.values(byCode).filter((entry) => !entry.family).length };
  }, { genres, locales });
}

export async function inspectGenre(page, code, language) {
  await expect.poll(async () => page.evaluate(({ code, language }) => window.__musicmapCompleteAudit.inspect(code, language).mismatches, { code, language }), { timeout: 10000, intervals: [100, 150, 250] }).toEqual([]);
  return page.evaluate(({ code, language }) => window.__musicmapCompleteAudit.inspect(code, language), { code, language });
}

export async function navigateGenre(page, code) {
  await page.evaluate((code) => {
    const entry = window.__musicmapCompleteAudit.byCode[code];
    if (!entry) throw new Error('Unknown navigation target.');
    if (entry.family) {
      const link = [...document.querySelectorAll('#supergenres-list [data-code]')].find((node) => node.dataset.code === code);
      if (!link) throw new Error('Missing family navigation link.');
      link.click();
    } else {
      const select = document.querySelector('#genres-searchbox');
      select.value = code;
      if (select.value !== code) throw new Error('The original search selector cannot select this genre.');
      document.querySelector('#genres-navigate-button').click();
    }
  }, code);
}

async function language(page, value) {
  await page.locator(`#mmzh-root [data-lang="${value}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', value);
  await expect(page.locator('#mmzh-root #status')).toHaveText(value === 'en' ? 'Original English' : value === 'zh-Hans' ? '完整静态译本' : '完整靜態譯本');
}

/** Exercise the original controls; an absent or unreachable button is a failure. */
export async function verifyPaneControls(page, { family, reopen }) {
  const pane = page.locator(family ? '#supergenre-side-pane' : '#genre-side-pane');
  const button = page.locator(family ? '#supergenre-side-pane-title .close' : '#right-side-pane-toggle-button');
  const openClass = family ? /\bsupergenre-side-pane-open\b/ : /\bright-side-pane-visible\b/;
  await expect(pane).toHaveClass(openClass);
  await expect(button).toHaveCount(1);
  await expect(button).toBeVisible();
  await expect(button).toBeInViewport({ ratio: 1 });
  const open = await pane.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(open.x >= 49 && open.x + open.width <= viewport.width + 1, 'The open detail pane must leave the navigation strip and fit the viewport.');
  const navigation = await page.locator('#sidebar-wrapper').boundingBox();
  assert.equal(Math.round(navigation.x), 0);
  assert.equal(Math.round(navigation.width), 50);
  await expect(page.locator('#musicmap-button')).toBeInViewport({ ratio: 1 });
  await page.locator('#musicmap-button').click({ trial: true });
  await button.click();
  await expect(pane).not.toHaveClass(openClass);
  await expect.poll(async () => {
    const box = await pane.boundingBox();
    return family ? box.x + box.width <= 0 : box.x >= viewport.width - 1;
  }).toBe(true);
  const closed = await pane.boundingBox();
  if (family) {
    assert.equal(typeof reopen, 'function', 'Family close verification requires an actual reopen action.');
    await reopen();
  } else {
    await expect(button).toBeInViewport({ ratio: 1 });
    await button.click();
  }
  await expect(pane).toHaveClass(openClass);
  await expect.poll(async () => Math.round((await pane.boundingBox()).x)).toBe(Math.round(open.x));
  return { kind: family ? 'family-close-and-reopen' : 'genre-collapse-and-expand', open, closed, reopened: await pane.boundingBox(), navigation };
}

export async function setPaneListOpen(page, { family, open }) {
  const pane = page.locator(family ? '#supergenre-side-pane' : '#genre-side-pane');
  const container = pane.locator('.side-pane-sub-pane-container');
  const handle = pane.locator('.side-pane-sub-pane-handle');
  await expect(handle).toHaveCount(1);
  const isOpen = /\bside-pane-sub-pane-container-open\b/.test(await container.getAttribute('class'));
  if (isOpen !== open) await handle.click();
  if (open) await expect(container).toHaveClass(/\bside-pane-sub-pane-container-open\b/);
  else await expect(container).not.toHaveClass(/\bside-pane-sub-pane-container-open\b/);
  const bounds = await pane.boundingBox();
  await expect.poll(async () => Math.round((await handle.boundingBox()).y)).toBe(Math.round(bounds.y + (open ? 105 : bounds.height - 104)));
}

async function layoutEvidence(page, prefix, genres, outputDirectory) {
  const evidence = [];
  await language(page, 'zh-Hant');
  if (Math.round((await page.locator('#supergenres-side-pane').boundingBox())?.x ?? -1) !== 50) await page.locator('#supergenres-toggle-button').click();
  await expect.poll(async () => Math.round((await page.locator('#supergenres-side-pane').boundingBox())?.x ?? -1)).toBe(50);
  const longestFamily = await page.locator('#supergenres-list a[data-code]').evaluateAll((nodes) => nodes.map((node) => ({ code: node.dataset.code, text: node.textContent })).sort((a, b) => b.text.length - a.text.length)[0]);
  await page.locator(`#supergenres-list a[data-code="${longestFamily.code}"]`).scrollIntoViewIfNeeded();
  const familyScreenshot = resolve(outputDirectory, `${prefix}-long-family-labels.png`);
  await page.screenshot({ path: familyScreenshot });
  evidence.push({ kind: 'long-family-labels', code: longestFamily.code, text: longestFamily.text, screenshot: familyScreenshot });
  await page.locator('#glossary-toggle-button').click();
  await expect.poll(async () => Math.round((await page.locator('#glossary-side-pane').boundingBox())?.x ?? -1)).toBe(50);
  const longestGlossary = await page.locator('#glossary-list > li > span,#genre-prefixes-list > li > span').evaluateAll((nodes) => nodes.map((node, index) => ({ index, text: node.textContent })).sort((a, b) => b.text.length - a.text.length)[0]);
  await page.locator('#glossary-list > li > span,#genre-prefixes-list > li > span').nth(longestGlossary.index).scrollIntoViewIfNeeded();
  const glossaryScreenshot = resolve(outputDirectory, `${prefix}-long-glossary-label.png`);
  await page.screenshot({ path: glossaryScreenshot });
  evidence.push({ kind: 'long-glossary-label', text: longestGlossary.text, screenshot: glossaryScreenshot });
  await page.locator('#glossary-toggle-button').click();
  const compound = await page.evaluate(() => Object.entries(window.__musicmapCompleteAudit.byCode).filter(([, entry]) => !entry.family).sort((a, b) => b[1].expected['zh-Hant'].title.texts.join('').length - a[1].expected['zh-Hant'].title.texts.join('').length)[0][0]);
  await navigateGenre(page, compound);
  await inspectGenre(page, compound, 'zh-Hant');
  await setPaneListOpen(page, { family: false, open: false });
  await expect(page.locator('#right-side-pane-genre-name')).toHaveCSS('opacity', '1');
  const titleGeometry = await page.locator('#right-side-pane-genre-name').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { text: node.textContent, x: rect.x, width: rect.width, height: rect.height, viewportWidth: innerWidth, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
  });
  assert.ok(titleGeometry.x >= 49 && titleGeometry.x + titleGeometry.width <= titleGeometry.viewportWidth + 1, `${prefix}: compound genre title exceeds the viewport or covers the navigation strip.`);
  assert.ok(titleGeometry.scrollWidth <= titleGeometry.clientWidth + 1, `${prefix}: compound genre title overflows horizontally.`);
  const compoundScreenshot = resolve(outputDirectory, `${prefix}-long-compound-genre.png`);
  await page.screenshot({ path: compoundScreenshot });
  const mapLabel = await page.locator(`#main-genres text[data-code="${compound}"]`).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { text: node.textContent, fontSize: getComputedStyle(node).fontSize, textLength: node.getAttribute('textLength'),
      spans: [...node.querySelectorAll('tspan')].map((span) => ({ text: span.textContent, textLength: span.getAttribute('textLength') })),
      x: box.x, y: box.y, width: box.width, height: box.height };
  });
  evidence.push({ kind: 'long-compound-genre', code: compound, geometry: titleGeometry, mapLabel, screenshot: compoundScreenshot });
  evidence.push({ viewport: prefix, ...await verifyPaneControls(page, { family: false }) });
  const longest = Object.entries(genres).sort((a, b) => b[1].description.length - a[1].description.length)[0][0];
  await navigateGenre(page, longest);
  await inspectGenre(page, longest, 'zh-Hant');
  await setPaneListOpen(page, { family: Array.isArray(genres[longest].genrelist), open: false });
  const selector = Array.isArray(genres[longest].genrelist) ? '#supergenre-side-pane-genre-description' : '#right-side-pane-genre-description';
  await expect(page.locator(selector)).toHaveCSS('opacity', '1');
  const geometry = await page.locator(selector).evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const ancestors = [];
    for (let parent = node.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth += 1) {
      const style = getComputedStyle(parent);
      ancestors.push({ id: parent.id, className: parent.className, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight, overflowY: style.overflowY });
    }
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, fontSize: getComputedStyle(node).fontSize, ancestors };
  });
  assert.ok(geometry.x >= 49 && geometry.x + geometry.width <= geometry.viewportWidth + 1, `${prefix}: long description exceeds the viewport width or covers the navigation strip.`);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${prefix}: long description overflows horizontally.`);
  const proseScreenshot = resolve(outputDirectory, `${prefix}-long-description.png`);
  await page.screenshot({ path: proseScreenshot });
  evidence.push({ kind: 'long-description', code: longest, geometry, screenshot: proseScreenshot });
  const scrolling = await page.locator(selector).evaluate((node) => {
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight + 1) {
        const before = parent.scrollTop; parent.scrollTop = parent.scrollHeight;
        if (parent.scrollTop > before) return { id: parent.id, before, after: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight };
      }
    }
    return null;
  });
  assert.ok(scrolling || geometry.y + geometry.height <= geometry.viewportHeight, `${prefix}: long description cannot be scrolled into view.`);
  if (scrolling) {
    const bottomScreenshot = resolve(outputDirectory, `${prefix}-long-description-bottom.png`);
    await page.screenshot({ path: bottomScreenshot });
    evidence.push({ kind: 'long-description-bottom', code: longest, scrolling, screenshot: bottomScreenshot });
  }
  evidence.push({ viewport: prefix, ...await verifyPaneControls(page, { family: Array.isArray(genres[longest].genrelist), reopen: () => navigateGenre(page, longest) }) });
  return evidence;
}

/** Real source data only. This intentionally refuses partial builds before opening a browser. */
export async function runCompleteSiteAudit({ rootDir = ROOT, outputDirectory = resolve(rootDir, 'artifacts/complete-site-audit'), codes = null } = {}) {
  const verified = await verifyRelease({ rootDir });
  const source = await readJson(rootDir, '.cache/source/strings.json');
  const genres = await readJson(rootDir, 'dist/master-genrelist.json');
  const locales = Object.fromEntries(await Promise.all(['zh-Hans', 'zh-Hant'].map(async (value) => [value, await readJson(rootDir, `dist/_zh/locales/${value}.json`)])));
  const shardVerification = await verifyFullShards(rootDir, source, verified.sourceHash, locales['zh-Hans']);
  const requested = codes ?? Object.keys(genres);
  assert.ok(requested.length && requested.every((code) => Object.hasOwn(genres, code)), 'Unknown or empty diagnostic genre selection.');
  await mkdir(outputDirectory, { recursive: true });
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), passed: false,
    scope: codes ? 'selected-code-diagnostic' : 'complete-real-site', sourceHash: verified.sourceHash,
    conversion: verified.conversion, shardVerification, expectedRecords: Object.keys(genres).length,
    fullCoverageRequested: codes === null, visited: [], representativeClicks: [], layout: [],
    errors: [], localFailures: [], blockedExternalRequests: [], translationApiRequests: [],
    limitations: ['Functionality and locale fidelity are checked; this is not a translation-quality score.', 'Offline map checks do not verify online YouTube or Spotify playback.', 'Source extraction boundaries are reported separately; complete 7,801-string coverage does not prove every visible English token was extracted.'],
  };
  const server = createApp({ directory: resolve(rootDir, 'dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let activeTarget = null;
  let activePage = null;
  async function freshPage(options) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    activePage = page;
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('request', (request) => { if (/deepseek|\/_zh\/api\/translate|\/api\/translate/i.test(request.url())) report.translationApiRequests.push(request.url()); });
    page.on('response', (response) => { if (new URL(response.url()).origin === origin && response.status() >= 400) report.localFailures.push({ url: response.url(), status: response.status() }); });
    page.on('requestfailed', (request) => { if (new URL(request.url()).origin === origin) report.localFailures.push({ url: request.url(), failure: request.failure()?.errorText }); });
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      report.blockedExternalRequests.push(route.request().url()); return route.abort();
    });
    await page.goto(origin, { waitUntil: 'networkidle' });
    const consent = page.locator('#privacy-policy-accept-btn');
    if (await consent.isVisible()) await consent.click();
    await page.locator('#genres-navigate-button:not([disabled])').waitFor({ state: 'attached', timeout: 15000 });
    await expect(page.locator('#mmzh-root #status')).toHaveText('完整靜態譯本');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
    const inventory = await installInspectionHelpers(page, genres, locales);
    assert.deepEqual(inventory.missing, []); assert.deepEqual(inventory.unknown, []);
    assert.equal(inventory.navigation.length, Object.keys(genres).length);
    return { page, inventory };
  }
  try {
    browser = await chromium.launch({ headless: true });
    const { page, inventory } = await freshPage({ viewport: { width: 1440, height: 960 } });
    report.inventory = inventory;
    const terminology = await readJson(rootDir, 'data/terminology.json');
    report.terminologySpotChecks = ['blues', 'grunge', 'rap', 'techno'].map((id) => {
      const term = terminology.terms.find((entry) => entry.id === id);
      const keys = source.filter((text) => term.english.includes(text.toLowerCase()));
      assert.ok(keys.length, `No source terms exist for ${id}.`);
      for (const key of keys) {
        assert.ok(locales['zh-Hans'][key].includes(term.simplified), `Simplified ${id} preference mismatch.`);
        assert.ok(locales['zh-Hant'][key].includes(term.traditional), `Traditional ${id} preference mismatch.`);
      }
      return { term: id, sourceKeys: keys, simplified: term.simplified, traditional: term.traditional };
    });
    for (const code of requested) {
      activeTarget = { code, language: 'zh-Hant' };
      await language(page, 'zh-Hant');
      await navigateGenre(page, code);
      const hant = await inspectGenre(page, code, 'zh-Hant');
      activeTarget.language = 'zh-Hans';
      await language(page, 'zh-Hans');
      const hans = await inspectGenre(page, code, 'zh-Hans');
      report.visited.push({ code, kind: Array.isArray(genres[code].genrelist) ? 'family' : 'genre', hant, hans });
      if (report.visited.length % 25 === 0) console.log(`Complete-site audit: ${report.visited.length}/${requested.length} real navigation targets checked in both Chinese languages.`);
    }
    activeTarget = null;
    if (!codes) {
    await language(page, 'zh-Hant');
    await page.locator('#mmzh-root #open-search').click();
    await page.locator('#mmzh-root #search').fill('油漬');
    await expect(page.locator('#mmzh-root #results button').first()).toContainText('GRUNGE');
    await page.locator('#mmzh-root #results button').first().click();
    await inspectGenre(page, 'alt04', 'zh-Hant');
    await page.locator('#right-side-pane-supergenre-first-tag a[data-code="alt"]').click();
    await inspectGenre(page, 'alt', 'zh-Hant');
    await setPaneListOpen(page, { family: true, open: true });
    await page.locator('.supergenre-side-pane-genre-list a[data-code="alt09"]').click();
    await inspectGenre(page, 'alt09', 'zh-Hant');
    report.representativeClicks.push({ input: 'Chinese search 油漬', target: 'alt04' }, { input: 'Original family tag link', target: 'alt' }, { input: 'Original family genre-list link', target: 'alt09' });
    const representatives = [...new Set(['gld', 'met', 'tec02', 'hou05', 'alt04', 'alt09', ...Object.entries(genres).filter(([, entry]) => /Stockhausen|George Martin|Brian Wilson|Phil Spector|1971/.test(entry.description)).map(([code]) => code)])];
    report.threeLanguageSamples = [];
    for (const code of representatives) {
      if (!genres[code]) continue;
      await navigateGenre(page, code);
      for (const value of ['en', 'zh-Hans', 'zh-Hant']) {
        await language(page, value);
        const result = await inspectGenre(page, code, value);
        if (value === 'en') await expect(page.locator('[data-mmzh-original]')).toHaveCount(0);
        report.threeLanguageSamples.push(result);
      }
    }
    report.layout.push(...await layoutEvidence(page, 'desktop', genres, outputDirectory));
    const { page: small } = await freshPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await navigateGenre(small, 'alt04');
    for (const value of ['zh-Hant', 'zh-Hans', 'en']) { await language(small, value); await inspectGenre(small, 'alt04', value); }
    await language(small, 'zh-Hant');
    await small.locator('#right-side-pane-supergenre-first-tag a[data-code="alt"]').click();
    await inspectGenre(small, 'alt', 'zh-Hant');
    await expect(small.locator('#genre-side-pane')).not.toHaveClass(/\bright-side-pane-visible\b/);
    await setPaneListOpen(small, { family: true, open: true });
    await small.locator('.supergenre-side-pane-genre-list a[data-code="alt09"]').click();
    await inspectGenre(small, 'alt09', 'zh-Hant');
    await expect(small.locator('#supergenre-side-pane')).not.toHaveClass(/\bsupergenre-side-pane-open\b/);
    report.representativeClicks.push({ viewport: 'mobile', input: 'Original family tag link', target: 'alt' }, { viewport: 'mobile', input: 'Original family genre-list link', target: 'alt09' });
    report.layout.push(...await layoutEvidence(small, 'mobile', genres, outputDirectory));
    } else await page.screenshot({ path: resolve(outputDirectory, 'diagnostic.png') });
    assert.deepEqual(report.errors, [], 'Browser JavaScript errors occurred.');
    assert.deepEqual(report.localFailures, [], 'Local built resources failed to load.');
    assert.deepEqual(report.translationApiRequests, [], 'A runtime translation request was attempted.');
    report.totalCheckedChineseViews = report.visited.length * 2;
    report.internalLinksPerLanguage = report.visited.reduce((sum, entry) => sum + entry.hant.internalLinks, 0);
    report.songNamesPerLanguage = report.visited.reduce((sum, entry) => sum + entry.hant.songs, 0);
    report.localeHashes = Object.fromEntries(Object.entries(locales).map(([key, value]) => [key, digest(value)]));
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = { target: activeTarget, message: error.message };
    if (activePage) {
      try {
        if (activeTarget) report.failure.inspection = await activePage.evaluate(({ code, language }) => window.__musicmapCompleteAudit.inspect(code, language), activeTarget);
        await activePage.screenshot({ path: resolve(outputDirectory, 'failure.png') });
      } catch { /* Keep the primary failure if the page already closed. */ }
    }
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.blockedExternalRequests = [...new Set(report.blockedExternalRequests)];
    await writeFile(resolve(outputDirectory, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: node test/complete-site.mjs [--code GENRE_CODE]\nRequires the fully verified strict build. No fixture content, external requests, translation API calls, or production file mutations. --code is a diagnostic subset, not complete-site acceptance.');
  else {
    if (args.length && (args.length !== 2 || args[0] !== '--code')) throw new Error('Use --help for complete-site audit options.');
    runCompleteSiteAudit({ codes: args.length ? [args[1]] : null }).then((result) => console.log(JSON.stringify({ passed: result.passed, scope: result.scope, targets: result.visited.length, chineseViews: result.totalCheckedChineseViews, sourceBoundaryCount: result.inventory.sourceBoundaries.length }, null, 2))).catch((error) => { console.error(`Complete-site audit failed: ${error.message}`); process.exitCode = 1; });
  }
}
