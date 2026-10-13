import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../server.mjs';

const server = createApp();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const requests = [];
await mkdir('artifacts', { recursive: true });

async function offlinePage(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  return page;
}
async function ready(page) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  const consent = page.locator('#privacy-policy-accept-btn');
  if (await consent.isVisible()) await consent.click();
  await page.locator('#genres-navigate-button:not([disabled])').waitFor({ state: 'attached', timeout: 15000 });
  await expect(page.locator('#mmzh-root #status')).not.toContainText('載入');
}

try {
  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await offlinePage(desktop);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(page.locator('#search-field')).toHaveAttribute('placeholder', '搜尋');
  const familyLink = page.locator('#supergenres-list a[data-code="inl"]');
  const familyEnglish = 'INDUSTRIAL & GOTHIC';
  await expect(familyLink).toHaveText(`工業與哥德${familyEnglish}`);
  await expect(familyLink.locator('[data-mmzh-original]')).toHaveText(familyEnglish);
  const mapFamily = page.locator('#supergenre-titles .main-titles > text:not([data-mmzh-original])').filter({ hasText: /^藍調$/ });
  await expect(mapFamily).toHaveCount(1);
  const originalMapStructure = await page.locator('#musicmap text:not([data-mmzh-original])').evaluateAll(nodes => nodes.map(node => ({
    transform: node.getAttribute('transform'), code: node.getAttribute('data-code'),
    spans: [...node.querySelectorAll('tspan')].map(span => [span.getAttribute('x'), span.getAttribute('y')]),
  })));
  await expect(page.locator('#supergenre-titles .main-titles > [data-mmzh-original]').filter({ hasText: /^BLUES$/ })).toHaveCount(1);
  await expect(page.locator('#glossary-list > li > span').filter({ hasText: '碎拍' }).locator('[data-mmzh-original]')).toHaveText('breakbeat');
  await page.locator('#mmzh-root [data-lang="zh-Hans"]').click();
  await expect(page.locator('#search-field')).toHaveAttribute('placeholder', '搜索');
  await expect(familyLink).toHaveText(`工业与哥特${familyEnglish}`);
  await expect(familyLink.locator('[data-mmzh-original]')).toHaveCount(1);
  await page.locator('#mmzh-root [data-lang="en"]').click();
  await expect(page.locator('#search-field')).toHaveAttribute('placeholder', 'Search');
  await expect(familyLink).toHaveText(familyEnglish);
  await expect(page.locator('[data-mmzh-original]')).toHaveCount(0);
  await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
  await expect(familyLink.locator('[data-mmzh-original]')).toHaveCount(1);
  expect(await page.locator('#musicmap text:not([data-mmzh-original])').evaluateAll(nodes => nodes.map(node => ({
    transform: node.getAttribute('transform'), code: node.getAttribute('data-code'),
    spans: [...node.querySelectorAll('tspan')].map(span => [span.getAttribute('x'), span.getAttribute('y')]),
  })))).toEqual(originalMapStructure);
  // Original SVG labels remain independent of annotations and retain their nodes.
  await page.locator('#supergenres-toggle-button').click();
  await expect(familyLink).toBeVisible();
  await expect.poll(async () => Math.round((await page.locator('#supergenres-side-pane').boundingBox()).x)).toBe(50);
  await page.mouse.move(750, 30);
  await page.screenshot({ path: 'artifacts/desktop-bilingual-families.png' });
  await familyLink.click();
  await expect(page.locator('#supergenre-side-pane-genre-name [data-mmzh-original]')).toHaveText(/INDUSTRIAL/);
  await page.locator('#supergenre-side-pane-title .close').click();
  await page.locator('#musicmap-button').click();
  const beforeZoom = await page.locator('#viewport').getAttribute('transform');
  await page.locator('#zoom-in').click();
  await expect(page.locator('#viewport')).not.toHaveAttribute('transform', beforeZoom || '');
  const beforeDrag = await page.locator('#viewport').getAttribute('transform');
  await page.mouse.move(650, 550); await page.mouse.down(); await page.mouse.move(740, 575, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('#viewport')).not.toHaveAttribute('transform', beforeDrag);

  await page.locator('#mmzh-root #open-search').click();
  await page.locator('#mmzh-root #search').fill('油漬');
  await expect(page.locator('#mmzh-root #results button').first()).toContainText('GRUNGE');
  await page.locator('#mmzh-root #results button').first().click();
  await expect(page.locator('#right-side-pane-genre-name')).toContainText('油漬搖滾', { timeout: 10000 });
  await expect(page.locator('#right-side-pane-genre-description')).not.toBeEmpty();
  await expect(page.locator('#right-side-pane-supergenre-first-tag [data-mmzh-original]')).toHaveCount(1);
  const song = await page.locator('#right-side-pane-songlist').textContent();
  await page.locator('#mmzh-root [data-lang="en"]').click();
  await expect(page.locator('#right-side-pane-genre-name')).toContainText('GRUNGE');
  await page.locator('#mmzh-root [data-lang="zh-Hans"]').click();
  await expect(page.locator('#right-side-pane-genre-name')).toContainText('垃圾摇滚');
  await expect(page.locator('#right-side-pane-songlist')).toHaveText(song);
  await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
  await page.screenshot({ path: 'artifacts/desktop-preview.png' });

  // A prebuilt fixture tests translated prose with an embedded, still-clickable link.
  const source = JSON.parse(await readFile(resolve('dist/master-genrelist.json'), 'utf8'));
  source.alt04.description = 'Fixture prose before a link. <a data-code="alt09">POST-ROCK</a> Fixture prose after a link.';
  await page.route('**/master-genrelist.json', route => route.fulfill({ json: source }));
  for (const lang of ['zh-Hans', 'zh-Hant']) {
    const locale = JSON.parse(await readFile(resolve(`dist/_zh/locales/${lang}.json`), 'utf8'));
    locale['Fixture prose before a link.'] = lang === 'zh-Hans' ? '链接前的测试文字。' : '連結前的測試文字。';
    locale['Fixture prose after a link.'] = lang === 'zh-Hans' ? '链接后的测试文字。' : '連結後的測試文字。';
    locale.fusion = '融合';
    locale.arpeggio = '琶音（arpeggio）';
    await page.route(`**/_zh/locales/${lang}.json`, route => route.fulfill({ json: locale }));
  }
  await ready(page);
  await expect(page.locator('#glossary-list > li > span').filter({ hasText: /^融合/ }).locator('[data-mmzh-original]')).toHaveText('fusion');
  const alreadyBilingual = page.locator('#glossary-list > li > span').filter({ hasText: /^琶音/ });
  await expect(alreadyBilingual).toHaveText('琶音（arpeggio）');
  await expect(alreadyBilingual.locator('[data-mmzh-original]')).toHaveCount(0);
  await expect(page.locator('#glossary-list > li > span').filter({ hasText: /^blue notes$/ }).locator('[data-mmzh-original]')).toHaveCount(0);
  await page.locator('#mmzh-root #open-search').click();
  await page.locator('#mmzh-root #search').fill('油漬');
  await page.locator('#mmzh-root #results button').first().click();
  await expect(page.locator('#right-side-pane-genre-description')).toContainText('連結前的測試文字。', { timeout: 10000 });
  await page.locator('#mmzh-root [data-lang="en"]').click();
  await expect(page.locator('#right-side-pane-genre-description')).toContainText('Fixture prose before a link.');
  await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
  await page.locator('#right-side-pane-genre-description a[data-code="alt09"]').click();
  await expect(page.locator('#right-side-pane-genre-name')).toContainText('後搖滾');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const small = await offlinePage(mobile);
  await ready(small);
  expect(new URL(small.url()).origin).toBe(origin);
  const bar = await small.locator('#mmzh-root').boundingBox();
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(391);
  await small.locator('#mmzh-root [data-lang="zh-Hans"]').click();
  await expect(small.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await small.locator('#supergenres-toggle-button').click();
  await expect(small.locator('#supergenres-list a[data-code="inl"] [data-mmzh-original]')).toBeVisible();
  await expect.poll(async () => Math.round((await small.locator('#supergenres-side-pane').boundingBox()).x)).toBe(50);
  const familyPane = await small.locator('#supergenres-side-pane').boundingBox();
  expect(familyPane.x + familyPane.width).toBeLessThanOrEqual(390);
  const familyNote = await small.locator('#supergenres-side-pane .small-side-pane-title [data-mmzh-original]').boundingBox();
  expect(familyNote.x).toBeGreaterThanOrEqual(50);
  expect(familyNote.x + familyNote.width).toBeLessThanOrEqual(390);
  await small.screenshot({ path: 'artifacts/mobile-preview.png' });
  expect(requests.filter(url => /deepseek|\/_zh\/api\/translate/.test(url))).toEqual([]);
  expect(errors).toEqual([]);
  console.log('PASS: desktop/mobile, offline map, zoom/drag, Chinese search, three languages, visible English family/glossary labels, preserved SVG structure and prose links, no translation API calls.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
