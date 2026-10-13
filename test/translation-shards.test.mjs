import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSource, parseArguments, runTranslation, shardForText } from '../scripts/translate.mjs';
import { mergeTranslations, parseMergeArguments } from '../scripts/merge-translations.mjs';

async function fixture(t, source) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-shards-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, '.cache/source'), { recursive: true });
  await mkdir(join(rootDir, 'generated/site'), { recursive: true });
  await writeFile(join(rootDir, 'generated/site/index.html'), '');
  await writeFile(join(rootDir, 'generated/site/master-genrelist.json'), '{}');
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(source));
  return rootDir;
}

async function putJson(rootDir, path, value) {
  const location = join(rootDir, path);
  await mkdir(join(location, '..'), { recursive: true });
  await writeFile(location, JSON.stringify(value));
}

async function getJson(rootDir, path) {
  return JSON.parse(await readFile(join(rootDir, path), 'utf8'));
}

function fakeApi(seen = []) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    const { texts } = JSON.parse(request.messages[1].content);
    const prefix = request.messages[0].content.includes('Traditional Chinese') ? '繁體' : '简体';
    seen.push(...texts);
    return Response.json({ choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({ translations: texts.map((text) => `${prefix}：${text}`) }) },
    }] });
  };
}

async function wrapper(rootDir, { text = 'A unique original paragraph.', translation = '一段翻譯。', language = 'zh-Hans', count = 3 } = {}) {
  const { sourceHash } = await loadSource(rootDir);
  return { sourceHash, language, shard: { index: shardForText(text, count), count }, translations: { [text]: translation } };
}

test('stable SHA256 partitions cover every source exactly once regardless of input order', () => {
  const source = ['Search', ...Array.from({ length: 100 }, (_, index) => `Source paragraph ${index}.`)];
  for (const count of [1, 2, 7, 150]) {
    const partitions = Array.from({ length: count }, (_, offset) => source.filter((text) => shardForText(text, count) === offset + 1));
    assert.deepEqual(partitions.flat().sort(), [...source].sort());
    for (const text of [...source].reverse()) {
      const expected = Number(BigInt(`0x${createHash('sha256').update(text).digest('hex')}`) % BigInt(count)) + 1;
      assert.equal(shardForText(text, count), expected);
    }
  }
});

test('shard mode resumes its own output and never touches global locales or status', async (t) => {
  const source = ['Search', ...Array.from({ length: 30 }, (_, index) => `Independent paragraph ${index}.`)];
  const rootDir = await fixture(t, source);
  const shard = { index: shardForText('Search', 3), count: 3 };
  const assigned = source.filter((text) => shardForText(text, shard.count) === shard.index);
  const localeSentinel = { sentinel: 'existing global locale' };
  const statusSentinel = { sentinel: 'existing global status' };
  await putJson(rootDir, 'generated/locales/zh-Hant.json', localeSentinel);
  await putJson(rootDir, 'generated/translation-status.json', statusSentinel);
  const seen = [];
  const lines = [];
  const settings = { rootDir, languages: ['zh-Hans'], shard, apiKey: 'test', fetchImpl: fakeApi(seen), log: (line) => lines.push(line) };
  const partial = await runTranslation({ ...settings, limit: 1 });
  assert.equal(partial.processed, 1);
  assert.equal(partial.status.total, assigned.length);
  assert.equal(partial.status.corpusTotal, source.length);
  assert.equal(partial.status.languages['zh-Hans'].complete, false);
  const shardPath = `generated/shards/zh-Hans-${shard.index}-of-${shard.count}.json`;
  const first = await getJson(rootDir, shardPath);
  assert.deepEqual(first.shard, shard);
  assert.equal(first.language, 'zh-Hans');
  assert.equal(first.translations.Search, '搜索');
  assert.equal(Object.keys(first.translations).length, 2);
  const firstTranslated = seen[0];
  seen.length = 0;

  const finished = await runTranslation(settings);
  assert.equal(finished.status.languages['zh-Hans'].complete, true);
  assert.match(lines.at(-1), /^COMPLETE for zh-Hans shard/);
  assert.ok(!seen.includes(firstTranslated));
  assert.ok(seen.every((text) => shardForText(text, shard.count) === shard.index));
  assert.deepEqual(Object.keys((await getJson(rootDir, shardPath)).translations).sort(), assigned.sort());
  assert.deepEqual(await getJson(rootDir, 'generated/locales/zh-Hant.json'), localeSentinel);
  assert.deepEqual(await getJson(rootDir, 'generated/translation-status.json'), statusSentinel);
  await assert.rejects(readFile(join(rootDir, 'generated/locales/zh-Hans.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(rootDir, `generated/shards/zh-Hant-${shard.index}-of-${shard.count}.json`)), { code: 'ENOENT' });
});

test('shard dry run makes no output and existing shards reject a changed snapshot', async (t) => {
  const rootDir = await fixture(t, ['Search', 'A unique original paragraph.']);
  const options = { rootDir, shard: { index: 1, count: 1 }, languages: ['zh-Hans'], apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Unexpected API call') };
  await runTranslation({ ...options, dryRun: true });
  await assert.rejects(readFile(join(rootDir, 'generated/shards/zh-Hans-1-of-1.json')), { code: 'ENOENT' });
  await runTranslation({ ...options, limit: 0 });
  await putJson(rootDir, '.cache/source/strings.json', ['Search', 'A unique original paragraph.', 'New source text.']);
  await assert.rejects(runTranslation({ ...options, limit: 0 }), /sourceHash/);
});

test('merge recomputes incomplete coverage, then becomes complete when remaining shards arrive', async (t) => {
  const source = ['Search', ...Array.from({ length: 30 }, (_, index) => `Distributed source paragraph ${index}.`)];
  const rootDir = await fixture(t, source);
  const settings = { rootDir, apiKey: 'test', fetchImpl: fakeApi(), log: () => {} };
  await runTranslation({ ...settings, shard: { index: 1, count: 3 } });
  const first = await mergeTranslations({ rootDir, log: () => {} });
  const assigned = source.filter((text) => shardForText(text, 3) === 1).length;
  assert.equal(first.files, 1);
  assert.deepEqual(first.status.languages['zh-Hans'], { translated: assigned, total: source.length, complete: false });
  assert.equal(first.status.languages['zh-Hans'].complete, false);
  for (const index of [2, 3]) await runTranslation({ ...settings, shard: { index, count: 3 } });
  const finished = await mergeTranslations({ rootDir, log: () => {} });
  assert.equal(finished.files, 3);
  assert.equal(finished.status.languages['zh-Hans'].complete, true);
  assert.equal(finished.status.languages['zh-Hant'].complete, false);
  assert.equal(finished.status.languages['zh-Hant'].derived, true);
  assert.equal(finished.added, source.length - assigned);
  assert.equal(Object.keys(await getJson(rootDir, 'generated/locales/zh-Hans.json')).length, source.length);
  await assert.rejects(readFile(join(rootDir, 'generated/locales/zh-Hant.json')), { code: 'ENOENT' });
  assert.deepEqual(await getJson(rootDir, 'generated/translation-status.json'), finished.status);
  assert.equal((await mergeTranslations({ rootDir, log: () => {} })).added, 0);
});

test('merge validates every input before writing and rejects snapshot mismatches', async (t) => {
  const rootDir = await fixture(t, ['A unique original paragraph.']);
  const valid = await wrapper(rootDir);
  await putJson(rootDir, 'generated/shards/first-valid.json', valid);
  await putJson(rootDir, 'generated/shards/nested/last-wrong.json', { ...valid, sourceHash: '0'.repeat(64) });
  await putJson(rootDir, 'generated/locales/zh-Hans.json', {});
  await putJson(rootDir, 'generated/translation-status.json', { unchanged: true });
  await assert.rejects(mergeTranslations({ rootDir, log: () => {} }), /sourceHash/);
  assert.deepEqual(await getJson(rootDir, 'generated/locales/zh-Hans.json'), {});
  assert.deepEqual(await getJson(rootDir, 'generated/translation-status.json'), { unchanged: true });
});

test('merge rejects conflicting translations within shards and against existing locales', async (t) => {
  const source = ['A unique original paragraph.'];
  const rootDir = await fixture(t, source);
  const first = await wrapper(rootDir);
  await putJson(rootDir, 'generated/shards/first.json', first);
  await putJson(rootDir, 'generated/shards/second.json', { ...first, translations: { [source[0]]: '不同的翻譯。' } });
  await assert.rejects(mergeTranslations({ rootDir, log: () => {} }), /Translation conflict/);
  await assert.rejects(readFile(join(rootDir, 'generated/locales/zh-Hans.json')), { code: 'ENOENT' });
  await rm(join(rootDir, 'generated/shards/second.json'));
  await putJson(rootDir, 'generated/locales/zh-Hans.json', { [source[0]]: '現有的翻譯。' });
  await assert.rejects(mergeTranslations({ rootDir, log: () => {} }), /Translation conflict/);
  assert.deepEqual(await getJson(rootDir, 'generated/locales/zh-Hans.json'), { [source[0]]: '現有的翻譯。' });
});

test('merge rejects invalid language, partition metadata, unknown source, and empty translations', async (t) => {
  const source = ['A unique original paragraph.'];
  for (const mutate of [
    (value) => ({ ...value, language: 'en' }),
    (value) => ({ ...value, shard: { index: 0, count: 3 } }),
    (value) => ({ ...value, shard: { index: 4, count: 3 } }),
    (value) => ({ ...value, shard: { index: value.shard.index % 3 + 1, count: 3 } }),
    (value) => ({ ...value, translations: { 'Unknown raw text.': '譯文' } }),
    (value) => ({ ...value, translations: { [source[0]]: '  ' } }),
    (value) => ({ ...value, translations: { [source[0]]: 42 } }),
    (value) => ({ ...value, translations: [] }),
  ]) {
    const rootDir = await fixture(t, source);
    await putJson(rootDir, 'generated/shards/invalid.json', mutate(await wrapper(rootDir)));
    await assert.rejects(mergeTranslations({ rootDir, log: () => {} }));
    await assert.rejects(readFile(join(rootDir, 'generated/translation-status.json')), { code: 'ENOENT' });
  }
});

test('merge preserves compatible existing translations absent from supplied shards', async (t) => {
  const rootDir = await fixture(t, ['A unique original paragraph.', 'Another original paragraph.']);
  await putJson(rootDir, 'generated/locales/zh-Hans.json', { 'Another original paragraph.': '另一段翻譯。', 'Old removed paragraph.': '過期' });
  await putJson(rootDir, 'generated/locales/zh-Hant.json', { 'Another original paragraph.': '保留繁體產物。' });
  await putJson(rootDir, 'generated/shards/one.json', await wrapper(rootDir));
  const merged = await mergeTranslations({ rootDir, log: () => {} });
  assert.deepEqual(await getJson(rootDir, 'generated/locales/zh-Hans.json'), {
    'A unique original paragraph.': '一段翻譯。', 'Another original paragraph.': '另一段翻譯。',
  });
  assert.equal(merged.status.languages['zh-Hans'].complete, true);
  assert.deepEqual(merged.status.languages['zh-Hant'], { translated: 1, total: 2, complete: false, derived: true });
  assert.deepEqual(await getJson(rootDir, 'generated/locales/zh-Hant.json'), { 'Another original paragraph.': '保留繁體產物。' });
});

test('merge rejects Traditional Chinese shards with a local conversion instruction', async (t) => {
  const rootDir = await fixture(t, ['A unique original paragraph.']);
  await putJson(rootDir, 'generated/shards/legacy-traditional.json', await wrapper(rootDir, { language: 'zh-Hant' }));
  await assert.rejects(mergeTranslations({ rootDir, log: () => {} }), /npm run convert/);
  await assert.rejects(readFile(join(rootDir, 'generated/translation-status.json')), { code: 'ENOENT' });
});

test('merge rejects mixed shard counts before updating any locale or status', async (t) => {
  const rootDir = await fixture(t, ['A unique original paragraph.', 'Another original paragraph.']);
  await putJson(rootDir, 'generated/shards/one.json', await wrapper(rootDir, { count: 2 }));
  await putJson(rootDir, 'generated/shards/two.json', await wrapper(rootDir, { text: 'Another original paragraph.', count: 3 }));
  await putJson(rootDir, 'generated/translation-status.json', { untouched: true });
  await assert.rejects(mergeTranslations({ rootDir, log: () => {} }), /mixed shard counts/);
  assert.deepEqual(await getJson(rootDir, 'generated/translation-status.json'), { untouched: true });
  await assert.rejects(readFile(join(rootDir, 'generated/locales/zh-Hans.json')), { code: 'ENOENT' });
});

test('CLI supports 1-based shards and merge directories while rejecting invalid partitions', () => {
  assert.deepEqual(parseArguments(['--shard', '2/3', '--limit=0']), { shard: { index: 2, count: 3 }, limit: 0 });
  assert.deepEqual(parseArguments(['--shard=1/1']), { shard: { index: 1, count: 1 } });
  for (const value of ['0/3', '4/3', '1/0', '1', '-1/3', '1/2.5', '1/999999999999999999999']) {
    assert.throws(() => parseArguments(['--shard', value]));
  }
  assert.deepEqual(parseMergeArguments([]), {});
  assert.deepEqual(parseMergeArguments(['--help']), { help: true });
  assert.deepEqual(parseMergeArguments(['/tmp/collected-shards']), { directory: '/tmp/collected-shards' });
  assert.throws(() => parseMergeArguments(['one', 'two']));
});
