import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeChapter, createUnitCatalog, validateChapterTranslation, parseChapterTranslation, stripChapterMarkers, validateUnitCatalog, readUnitCatalog } from '../lib/chapter-units.mjs';
import { convertText, convertToTraditional } from '../lib/chinese-conversion.mjs';
import { build } from '../scripts/build.mjs';

test('whole chapters retain short grammar, paragraphs, nested markup and single line breaks', () => {
  const unit = encodeChapter({ id: 'genre:test', html: 'A <b>whole</b> paragraph, with <a href="/kept"><i>music</i></a>.<br><br>One.<br>Two.<br><br>' });
  assert.equal(unit.source, '⟦p0⟧A ⟦m0⟧whole⟦/m0⟧ paragraph, with ⟦m1⟧⟦m2⟧music⟦/m2⟧⟦/m1⟧.⟦/p0⟧\n⟦p1⟧One.⟦br0⟧Two.⟦/p1⟧');
  assert.equal(unit.paragraphs.length, 2);
  assert.equal(unit.markers.m1.attributes.href, '/kept');
  assert.equal(unit.markers.m2.parent, 'm1');
  assert.equal(stripChapterMarkers(unit.source), 'A whole paragraph, with music.\n\nOne.\nTwo.');
  assert.equal(unit.layout.at(-1).type, 'separator');
});

test('natural sibling reordering is allowed; invalid data never becomes HTML or a partial chapter', () => {
  const source = '⟦p0⟧A ⟦m0⟧link⟦/m0⟧ and ⟦m1⟧emphasis⟦/m1⟧.⟦/p0⟧\n⟦p1⟧Another paragraph.⟦/p1⟧';
  const valid = '⟦p0⟧⟦m1⟧重点⟦/m1⟧与⟦m0⟧链接⟦/m0⟧。⟦/p0⟧\n⟦p1⟧另一整段。⟦/p1⟧';
  assert.equal(validateChapterTranslation(source, valid), true);
  assert.equal(parseChapterTranslation(source, valid).children.length, 2);
  for (const invalid of [
    valid.replace('⟦m0⟧链接⟦/m0⟧', '链接'),
    valid.replace('⟦m0⟧链接⟦/m0⟧', '⟦m0⟧链接⟦/m0⟧⟦m0⟧重复⟦/m0⟧'),
    valid.replace('⟦m0⟧链接⟦/m0⟧', '⟦m0⟧⟦/m0⟧'),
    valid.replace('⟦/m1⟧与⟦m0⟧', '⟦m0⟧与⟦/m1⟧'),
    valid.replace('⟦/p1⟧', ''),
    valid.replace('另一整段。', '<img src=x onerror=alert(1)>'),
    valid.replace('另一整段。', '⟦bad⟧'),
    'outside' + valid,
    valid.replace('另一整段。', ' '),
    valid.split('\n').reverse().join('\n'),
  ]) assert.throws(() => validateChapterTranslation(source, invalid));
});

test('catalog replaces body fragments with full prose keys while preserving UI labels and attributes', () => {
  const catalog = createUnitCatalog({
    html: '<html><body><h1>Search</h1><div id="intro"><p title="Useful hint">A <b>complete</b> paragraph.</p><button>Go</button></div></body></html>',
    genres: { demo: { name: 'ROCK', description: 'The <b>sound</b> is complete.<br><br>A second paragraph.' } },
  });
  assert.equal(catalog.units.length, 2);
  assert.equal(catalog.units[0].paragraphs.length, 2);
  assert.equal(catalog.units[1].targets[0].selector, '#intro > p:nth-of-type(1)');
  for (const label of ['Search', 'Go', 'Useful hint', 'ROCK']) assert.ok(catalog.source.includes(label));
  for (const fragment of ['complete', 'sound', 'The', 'A', 'paragraph.']) assert.ok(!catalog.source.includes(fragment));
  assert.equal(validateUnitCatalog(catalog), catalog);
  const damaged = structuredClone(catalog); damaged.units[0].title = 'Changed after freeze';
  assert.throws(() => validateUnitCatalog(damaged), /registry/);
});

test('OpenCC converts paragraph text with context while preserving the exact marker tree', () => {
  const source = '⟦p0⟧Blues has ⟦m0⟧power⟦/m0⟧.⟦/p0⟧\n⟦p1⟧Bruce Springsteen.⟦/p1⟧';
  const hans = '⟦p0⟧布鲁斯有⟦m0⟧力量⟦/m0⟧。⟦/p0⟧\n⟦p1⟧布鲁斯，Bruce Springsteen。⟦/p1⟧';
  const hant = convertText(source, hans);
  assert.equal(hant, '⟦p0⟧藍調有⟦m0⟧力量⟦/m0⟧。⟦/p0⟧\n⟦p1⟧布魯斯，Bruce Springsteen。⟦/p1⟧');
  assert.equal(validateChapterTranslation(source, hant), true);
});

test('short complete citations are never split into author/title fragments', () => {
  const catalog = createUnitCatalog({ html: '<div id="acknowledgements-literature-list"><ul><li>Author, <b>Book title</b>, 1999.</li></ul></div>' });
  assert.equal(catalog.units.length, 1);
  assert.equal(stripChapterMarkers(catalog.units[0].source), 'Author, Book title, 1999.');
  assert.ok(!catalog.source.includes('Author,'));
  assert.ok(!catalog.source.includes('Book title'));
});

test('catalog conversion/build are versioned, cannot claim a partial pilot complete, and can target an isolated build', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'musicmap-chapter-build-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  for (const directory of ['.cache/source', 'generated/site', 'generated/locales', 'public', 'dist']) await mkdir(join(projectRoot, directory), { recursive: true });
  const html = '<html><head><title>Source</title></head><body><p>A complete paragraph.</p><button>Untranslated button</button></body></html>';
  const catalog = createUnitCatalog({ html, genres: {} });
  const source = catalog.units[0].source, translated = '⟦p0⟧这是一个完整段落。⟦/p0⟧';
  await writeFile(join(projectRoot, '.cache/source/strings.json'), JSON.stringify(catalog.source));
  await assert.rejects(readUnitCatalog(projectRoot, catalog.source), /immutable unit registry/);
  await writeFile(join(projectRoot, '.cache/source/units.json'), JSON.stringify(catalog));
  await writeFile(join(projectRoot, 'generated/site/index.html'), html);
  const bundle = 'window.onYouTubeIframeAPIReady=function(){P=new YT.Player("one",{});};function again(){P=new YT.Player("two",{});}function use(){' + 'P.getPlayerState();'.repeat(10) + 'P.playVideoAt(1);P.cuePlaylist({});P.cuePlaylist({});}';
  await writeFile(join(projectRoot, 'generated/site/main.bundle.js'), bundle);
  for (const file of ['overlay.js', 'overlay.css', 'dictionary.js', 'chapter-renderer.js', 'chapter-caption-renderer.js']) await cp(resolve('public', file), join(projectRoot, 'public', file));
  await writeFile(join(projectRoot, 'generated/locales/zh-Hans.json'), JSON.stringify({ [source]: translated }));
  await writeFile(join(projectRoot, 'dist/index.html'), 'existing live preview');
  const metadata = await convertToTraditional({ rootDir: projectRoot, log() {} });
  assert.equal(metadata.unitCatalogHash, catalog.catalogHash);
  assert.equal(metadata.complete, false);
  await assert.rejects(build({ projectRoot }), /尚未全部完成/);
  const outputDir = join(projectRoot, 'pilot-output');
  const status = await build({ projectRoot, allowPartial: true, outputDir });
  assert.equal(status.languages['zh-Hans'].complete, false);
  assert.equal(status.unitCatalogHash, catalog.catalogHash);
  assert.equal(await readFile(join(projectRoot, 'dist/index.html'), 'utf8'), 'existing live preview');
  assert.equal(JSON.parse(await readFile(join(outputDir, '_zh/units.json'))).catalogHash, catalog.catalogHash);
  assert.equal(await readFile(join(outputDir, '_zh/chapter-caption-renderer.js'), 'utf8'), await readFile(resolve('public/chapter-caption-renderer.js'), 'utf8'));
  await writeFile(join(projectRoot, 'generated/locales/zh-Hans.json'), JSON.stringify({ [source]: 'broken' }));
  await assert.rejects(convertToTraditional({ rootDir: projectRoot, log() {} }));
});
