import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build, prepareBundle, prepareHTML } from '../scripts/build.mjs';
import { CONVERTER, convertToTraditional, hashLocale, sourceHash } from '../lib/chinese-conversion.mjs';
import { TERMINOLOGY_HASH } from '../lib/terminology.mjs';

function upstreamBundle(player = 'Bn') {
  return `var ${player};
    window.onYouTubeIframeAPIReady=function(){${player}=new YT.Player("youtube-player-iframe",{})};
    window.start=function(){${player}=new YT.Player("youtube-player-iframe",{});window.mapReady=true;};
    window.click=function(){
      var states=[${Array(10).fill(`${player}.getPlayerState()`).join(',')}];
      ${player}.playVideoAt(4);
      ${player}.cuePlaylist({list:"example"});
      setTimeout(function(){${player}.cuePlaylist({list:"example"})},500);
      window.clicked=true;return states;
    };`;
}

test('map initializes and clicks without YouTube, including renamed minified variables', () => {
  for (const name of ['Bn', '$player']) {
    const window = {};
    runInNewContext(prepareBundle(upstreamBundle(name)), { window, setTimeout: callback => callback() });
    window.start();
    assert.equal(window.mapReady, true);
    assert.ok(window.click().every(state => state === undefined));
    assert.equal(window.clicked, true);
  }
});

test('pending YouTube player is safe and late API readiness preserves playback and receiver', () => {
  const window = {};
  const context = { window, setTimeout: callback => callback() };
  runInNewContext(prepareBundle(upstreamBundle()), context);
  window.start(); // Offline at initial page load.
  const players = [];
  context.YT = { Player: function () { players.push(this); } };
  window.onYouTubeIframeAPIReady(); // API arrives, but player methods are not ready yet.
  assert.equal(players.length, 1);
  window.click();
  const player = players[0];
  const calls = [];
  for (const method of ['getPlayerState', 'playVideoAt', 'cuePlaylist']) {
    player[method] = function (argument) { assert.equal(this, player); calls.push([method, argument]); return 1; };
  }
  assert.ok(window.click().every(state => state === 1));
  assert.equal(calls.filter(([name]) => name === 'getPlayerState').length, 10);
  assert.equal(calls.find(([name]) => name === 'playVideoAt')[1], 4);
  assert.equal(calls.filter(([name]) => name === 'cuePlaylist').length, 2);
});

test('upstream player changes fail the build instead of silently producing a broken offline map', () => {
  for (const source of [
    'console.log("no known player");',
    upstreamBundle().replace('Bn.playVideoAt(4)', 'Bn.stopVideo()'),
    upstreamBundle().replace('Bn.cuePlaylist({list:"example"});', ''),
    upstreamBundle() + 'Bn.pauseVideo();',
  ]) assert.throws(() => prepareBundle(source), /YouTube.*變更/);
});

test('HTML removes mobile redirects and analytics while retaining map and media scripts', () => {
  const html = prepareHTML(`<html><head><title>Original</title></head><body>
    <script>navigator.userAgent;location="https://m.musicmap.info";</script>
    <script src="https://googletagmanager.com/track.js"></script>
    <script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('config','tracking-id');</script>
    <script>window.fbAsyncInit=function(){};</script>
    <script src="main.bundle.js"></script><script src="https://www.youtube.com/iframe_api"></script>
    </body></html>`, { languages: {} });
  assert.doesNotMatch(html, /m\.musicmap|googletagmanager|fbAsyncInit/);
  assert.match(html, /main\.bundle\.js/);
  assert.match(html, /youtube\.com\/iframe_api/);
  assert.match(html, /"mode":"static"/);
  assert.doesNotMatch(html, /dataLayer|tracking-id/);
  const retainedScript = html.match(/<script>(function gtag\(\)\{\})<\/script>/)?.[1];
  assert.ok(retainedScript);
  assert.doesNotThrow(() => runInNewContext(`${retainedScript};gtag('event','genre_clicked',{});`));
});

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'musicmap-build-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  for (const path of ['.cache/source', 'generated/site', 'generated/locales', 'public']) {
    await mkdir(join(projectRoot, path), { recursive: true });
  }
  await writeFile(join(projectRoot, '.cache/source/strings.json'), JSON.stringify(['Search', 'A genre description.']));
  await writeFile(join(projectRoot, 'generated/site/index.html'), '<html><head><title>Musicmap</title></head><body></body></html>');
  await writeFile(join(projectRoot, 'generated/site/main.bundle.js'), upstreamBundle());
  for (const file of ['overlay.js', 'overlay.css', 'dictionary.js']) await writeFile(join(projectRoot, 'public', file), '');
  return projectRoot;
}

async function locale(projectRoot, language, entries) {
  await writeFile(join(projectRoot, `generated/locales/${language}.json`), JSON.stringify(entries));
}

async function conversionMetadata(projectRoot, overrides = {}) {
  const readJson = async path => JSON.parse(await readFile(join(projectRoot, path), 'utf8'));
  const input = await readJson('.cache/source/strings.json');
  const metadata = {
    sourceHash: sourceHash(input),
    simplifiedHash: hashLocale(await readJson('generated/locales/zh-Hans.json')),
    traditionalHash: hashLocale(await readJson('generated/locales/zh-Hant.json')),
    terminologyHash: TERMINOLOGY_HASH,
    converter: CONVERTER,
    total: input.length, converted: input.length, complete: true,
    ...overrides,
  };
  await writeFile(join(projectRoot, 'generated/conversion-status.json'), JSON.stringify(metadata));
  return metadata;
}

test('release builds require both complete locales and leave the existing dist untouched on failure', async t => {
  const projectRoot = await fixture(t);
  await mkdir(join(projectRoot, 'dist'));
  await writeFile(join(projectRoot, 'dist/index.html'), 'previous build');
  await locale(projectRoot, 'zh-Hans', { Search: '搜索', 'A genre description.': '流派说明。' });
  await locale(projectRoot, 'zh-Hant', { Search: '搜尋', 'A genre description.': '   ' });
  await assert.rejects(build({ projectRoot }), /簡繁翻譯尚未全部完成/);
  assert.equal(await readFile(join(projectRoot, 'dist/index.html'), 'utf8'), 'previous build');
  const preview = await build({ projectRoot, allowPartial: true });
  assert.equal(preview.languages['zh-Hans'].complete, true);
  assert.equal(preview.languages['zh-Hant'].complete, false);
  assert.equal(preview.languages['zh-Hant'].translated, 1);
});

test('complete build bundles both static locales and patches only the distribution source', async t => {
  const projectRoot = await fixture(t);
  for (const language of ['zh-Hans', 'zh-Hant']) {
    await locale(projectRoot, language, { Search: '搜尋', 'A genre description.': '流派說明。' });
  }
  await convertToTraditional({ rootDir: projectRoot, log: () => {} });
  const status = await build({ projectRoot });
  assert.ok(Object.values(status.languages).every(language => language.complete));
  assert.equal(await readFile(join(projectRoot, 'generated/site/main.bundle.js'), 'utf8'), upstreamBundle());
  assert.equal(await readFile(join(projectRoot, 'dist/main.bundle.js'), 'utf8'), prepareBundle(upstreamBundle()));
  for (const language of ['zh-Hans', 'zh-Hant']) {
    assert.deepEqual(JSON.parse(await readFile(join(projectRoot, `dist/_zh/locales/${language}.json`), 'utf8')), { Search: '搜尋', 'A genre description.': '流派說明。' });
  }
  assert.deepEqual(JSON.parse(await readFile(join(projectRoot, 'dist/_zh/translation-status.json'), 'utf8')), status);
  await writeFile(join(projectRoot, 'generated/translation-status.json'), JSON.stringify({ sourceHash: 'outdated' }));
  await assert.rejects(build({ projectRoot }), /來源已更新/);
});

test('release requires conversion provenance even when both locale files have complete coverage', async t => {
  const projectRoot = await fixture(t);
  for (const language of ['zh-Hans', 'zh-Hant']) {
    await locale(projectRoot, language, { Search: '搜索', 'A genre description.': '流派说明。' });
  }
  await assert.rejects(build({ projectRoot }), /轉換記錄缺失或已過期.*npm run convert/);
  const preview = await build({ projectRoot, allowPartial: true });
  assert.equal(preview.languages['zh-Hans'].complete, true);
  assert.deepEqual(preview.languages['zh-Hant'], { translated: 2, total: 2, complete: false });
  const html = await readFile(join(projectRoot, 'dist/index.html'), 'utf8');
  assert.match(html, /"zh-Hant":\{"translated":2,"total":2,"complete":false\}/);
  await conversionMetadata(projectRoot);
  assert.equal((await build({ projectRoot })).languages['zh-Hant'].complete, true);
});

test('editing either locale invalidates conversion until metadata is refreshed', async t => {
  const projectRoot = await fixture(t);
  for (const language of ['zh-Hans', 'zh-Hant']) {
    await locale(projectRoot, language, { Search: '搜索', 'A genre description.': '流派说明。' });
  }
  await conversionMetadata(projectRoot);
  let previous = await build({ projectRoot });
  for (const language of ['zh-Hans', 'zh-Hant']) {
    await locale(projectRoot, language, { Search: '搜索', 'A genre description.': '已校对的说明。' });
    await assert.rejects(build({ projectRoot }), /轉換記錄缺失或已過期/);
    assert.deepEqual(JSON.parse(await readFile(join(projectRoot, 'dist/_zh/translation-status.json'), 'utf8')), previous);
    const preview = await build({ projectRoot, allowPartial: true });
    assert.equal(preview.languages['zh-Hant'].complete, false);
    await conversionMetadata(projectRoot);
    const refreshed = await build({ projectRoot });
    assert.equal(refreshed.languages['zh-Hant'].complete, true);
    previous = refreshed;
  }
});

test('stale source, incomplete conversion, and wrong converter metadata prevent release', async t => {
  const projectRoot = await fixture(t);
  for (const language of ['zh-Hans', 'zh-Hant']) {
    await locale(projectRoot, language, { Search: '搜索', 'A genre description.': '流派说明。' });
  }
  for (const overrides of [
    { sourceHash: 'outdated' },
    { simplifiedHash: 'outdated' },
    { traditionalHash: 'outdated' },
    { terminologyHash: 'outdated' },
    { complete: false },
    { total: 3 },
    { converted: 1 },
    { converter: { ...CONVERTER, to: 'hk' } },
    { converter: { ...CONVERTER, version: 'older' } },
  ]) {
    await conversionMetadata(projectRoot, overrides);
    await assert.rejects(build({ projectRoot }), /轉換記錄缺失或已過期/);
  }
});

test('empty source is never a complete release even if conversion metadata claims completion', async t => {
  const projectRoot = await fixture(t);
  await writeFile(join(projectRoot, '.cache/source/strings.json'), '[]');
  for (const language of ['zh-Hans', 'zh-Hant']) await locale(projectRoot, language, {});
  await conversionMetadata(projectRoot);
  await assert.rejects(build({ projectRoot }), /簡繁翻譯尚未全部完成/);
  const preview = await build({ projectRoot, allowPartial: true });
  for (const language of Object.values(preview.languages)) assert.deepEqual(language, { translated: 0, total: 0, complete: false });
});
