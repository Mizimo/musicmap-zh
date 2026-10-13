import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetPath, discoverAssetPaths, extractBundleStrings, extractGenreStrings,
  extractHtmlStrings, normalizeText, syncSource,
} from '../scripts/sync-source.mjs';

test('extracts leaf text and help attributes without scripts, songs or artist credits', () => {
  const result = extractHtmlStrings(`<p> A  <a data-code="jaz">jazz</a> history. </p>
    <svg><text><tspan>ACID</tspan><tspan>HOUSE</tspan></text></svg>
    <input placeholder=" Select  a genre "><i data-bs-content="More detail"></i>
    <script>const no = 'secret script';</script><style>body { color: red }</style>
    <ul id="right-side-pane-songlist"><li>Song title</li></ul>
    <span class="song-title">Another song</span><div id="people-list">Person name</div>`);
  assert.deepEqual(result, ['jazz', 'history.', 'ACID', 'HOUSE', 'Select a genre', 'More detail']);
  assert.equal(normalizeText('\nSome\u00a0 words  '), 'Some words');
});

test('genre extraction includes search names and linked prose while retaining original song names', () => {
  const result = extractGenreStrings({ jaz: {
    name: '<span>ACID</span> JAZZ', description: 'An <a data-code="jaz">early style</a>.',
    genrelist: ['<a>FREE JAZZ</a>'], 'supergenre-first-tag': '<a>JAZZ</a>',
    'supergenre-second-tag': ['master', '<a>FUNK</a>'], songlist: ['Original artist – Song'],
  } });
  assert.ok(result.includes('ACID JAZZ'));
  assert.ok(result.includes('early style'));
  assert.ok(result.includes('FREE JAZZ'));
  assert.ok(result.includes('FUNK'));
  assert.ok(!result.some(text => text.includes('Original artist')));
});

test('extracts dynamically embedded SVG text without running JavaScript', () => {
  const result = extractBundleStrings(`add('<svg><text font-family="\\\'Open Sans\\\'">decennial timeline</text></svg>');run("<div>More\\n detail</div>");evil('throw');`);
  assert.deepEqual(result, ['decennial timeline', 'More detail']);
});

test('asset discovery stays on the official origin and resolves nested CSS resources', () => {
  assert.deepEqual(discoverAssetPaths(
    '<script src="main.bundle.js"></script><svg><image href="assets/map.jpg"/></svg><link href="https://evil.example/secret.css"><a href="https://musicmap.info/book.pdf">Book</a>',
    '@import url("https://fonts.googleapis.com/css?family=X");body{background:url(assets/bg.jpg)}@font-face{src:url("assets/font.woff2")}',
    'var icon="assets/logo.svg";',
  ), ['assets/bg.jpg', 'assets/font.woff2', 'assets/logo.svg', 'assets/map.jpg', 'main.bundle.js']);
  assert.equal(assetPath('../fonts/test.woff2', 'https://musicmap.info/styles/app.css'), 'fonts/test.woff2');
  for (const path of ['//evil.example/a.js', 'https://musicmap.info.evil.example/a.js', 'data:image/svg+xml,x', '#local', '/%2e%2e%2fprivate.js', '/assets/a%5cb.js']) assert.equal(assetPath(path), null);
});

test('sync writes an inspectable snapshot and reuses it without network on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'musicmap-source-test-'));
  const payloads = {
    '/': '<html><body><p>Welcome here.</p><script src="main.bundle.js"></script><link href="main.css"><svg><image href="assets/map.jpg"/></svg></body></html>',
    '/main.bundle.js': 'const legend="<svg><text>decennial timeline</text></svg>";',
    '/main.css': 'body{background:url(assets/bg.jpg)}',
    '/master-genrelist.json': JSON.stringify({ jaz: { name: 'JAZZ', description: 'An early musical style.', songlist: ['Keep this song'] } }),
    '/assets/map.jpg': 'sample map bytes', '/assets/bg.jpg': 'sample background bytes',
  };
  const fetched = [];
  try {
    const first = await syncSource({ root, fetchImpl: async url => {
      fetched.push(url); const path = new URL(url).pathname;
      return new Response(payloads[path], { status: path in payloads ? 200 : 404 });
    } });
    assert.equal(first.resourceCount, 6);
    assert.equal(first.genreCount, 1);
    assert.ok(first.resources.every(resource => /^[a-f0-9]{64}$/.test(resource.sha256)));
    const strings = JSON.parse(await readFile(join(root, '.cache/source/strings.json'), 'utf8'));
    assert.ok(strings.includes('decennial timeline'));
    assert.ok(strings.includes('An early musical style.'));
    assert.ok(!strings.includes('Keep this song'));
    const second = await syncSource({ root, fetchImpl: () => assert.fail('Cached source must not be downloaded') });
    assert.equal(fetched.length, 6);
    assert.ok(second.resources.every(resource => resource.cached));
  } finally { await rm(root, { recursive: true, force: true }); }
});
