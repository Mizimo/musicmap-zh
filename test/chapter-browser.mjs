import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createUnitCatalog } from '../lib/chapter-units.mjs';
import { convertText } from '../lib/chinese-conversion.mjs';

const description = 'Read <a data-code="next" href="#kept">Noise Rock</a>, with <b>energy</b>.<br><br>Another whole paragraph.';
const missing = 'A <b>complete</b> untranslated paragraph.';
const pageHtml = '<html><body><h1>Search</h1><p id="intro">A <b>whole</b> paragraph with a link.</p><div id="right-side-pane-genre-description">' + description + '</div><div id="supergenre-side-pane-genre-description"></div></body></html>';
const catalog = createUnitCatalog({ html: pageHtml, genres: { demo: { name: 'Demo', description }, next: { name: 'Next', description: missing } } });
const genre = catalog.units.find(unit => unit.genreId === 'demo');
const pageUnit = catalog.units.find(unit => unit.kind === 'page' && unit.targets[0].selector === '#intro');
const hans = {
  [genre.source]: '⟦p0⟧⟦m1⟧力量⟦/m1⟧来自⟦m0⟧噪音摇滚⟦/m0⟧。⟦/p0⟧\n⟦p1⟧另外一个完整段落。⟦/p1⟧',
  [pageUnit.source]: '⟦p0⟧带有链接的⟦m0⟧完整⟦/m0⟧段落。⟦/p0⟧',
  // Deliberately poison old fragment keys: managed prose must ignore all of them.
  'Read': 'WRONG FRAGMENT', complete: 'WRONG FRAGMENT', 'untranslated paragraph.': 'WRONG FRAGMENT',
};
const hant = Object.fromEntries(Object.entries(hans).map(([source, value]) => [source, convertText(source, value)]));
const config = { mode: 'static', status: { unitCatalogHash: catalog.catalogHash, languages: { 'zh-Hans': { complete: false }, 'zh-Hant': { complete: false } } } };
const html = pageHtml.replace('</body>', `<script>window.clicks=0;window.originalLink=document.querySelector('#right-side-pane-genre-description a');window.originalLink.addEventListener('click',e=>{e.preventDefault();window.clicks++;});window.originalGenreHTML=document.querySelector('#right-side-pane-genre-description').innerHTML;</script><script id="mmzh-config" type="application/json">${JSON.stringify(config)}</script><script type="module" src="/_zh/overlay.js"></script></body>`);
const requests = [], errors = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
    else if (path === '/_zh/units.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(catalog)); }
    else if (path.startsWith('/_zh/locales/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(path.includes('zh-Hans') ? hans : hant)); }
    else if (/^\/_zh\/(?:overlay|chapter-renderer|dictionary)\.js$/.test(path)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve('public', path.split('/').at(-1)))); }
    else { response.statusCode = 404; response.end('missing'); }
  } catch (error) { response.statusCode = 500; response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin, { waitUntil: 'networkidle' });
  const pane = page.locator('#right-side-pane-genre-description');
  await expect(pane).toHaveText('力量來自噪音搖滾。另外一個完整段落。');
  await expect(page.locator('#intro')).toHaveText('帶有鏈接的完整段落。');
  assert.equal(await pane.locator('a').evaluate(node => node === window.originalLink), true);
  await expect(pane.locator('a')).toHaveAttribute('href', '#kept');
  await expect(pane.locator('a')).toHaveAttribute('data-code', 'next');
  await pane.locator('a').click();
  assert.equal(await page.evaluate(() => window.clicks), 1);
  await page.locator('#mmzh-root [data-lang="zh-Hans"]').click();
  await expect(pane).toHaveText('力量来自噪音摇滚。另外一个完整段落。');
  await page.locator('#mmzh-root [data-lang="en"]').click();
  assert.equal(await pane.innerHTML(), description);
  assert.equal(await page.evaluate(() => document.querySelector('#right-side-pane-genre-description a') === window.originalLink), true);
  await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
  await page.evaluate(value => { document.querySelector('#right-side-pane-genre-description').innerHTML = value; }, missing);
  await expect(pane).toHaveText('A complete untranslated paragraph.');
  await page.waitForTimeout(350);
  await expect(pane).not.toContainText('WRONG');
  await page.locator('#mmzh-root [data-lang="zh-Hans"]').click();
  await expect(pane).toHaveText('A complete untranslated paragraph.');
  await page.locator('#mmzh-root [data-lang="en"]').click();
  assert.equal(await pane.innerHTML(), missing);
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => new URL(url).origin === origin));
  console.log(JSON.stringify({ passed: true, checks: ['whole chapter render', 'sibling markup reordering', 'existing link identity and handler', 'exact English restore', 'Simplified/Traditional switching', 'navigation without fragment fallback', 'no external/API requests'] }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
