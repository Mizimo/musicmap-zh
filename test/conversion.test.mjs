import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONVERTER, convertText, convertToTraditional, hashLocale } from '../lib/chinese-conversion.mjs';
import { glossaryPrompt, relevantTerms, TERMINOLOGY_HASH } from '../lib/terminology.mjs';

test('uses phrase conversion plus source-aware professional terminology without changing English names', () => {
  assert.equal(convertText('Blues and Grunge', '布鲁斯（Blues）与垃圾摇滚（Grunge）'), '藍調（Blues）與油漬搖滾（Grunge）');
  assert.equal(convertText('Post-Grunge and Punk', '后垃圾摇滚、朋克'), '後油漬搖滾、龐克');
  assert.equal(convertText('Bruce is a musician', '布鲁斯是一位音乐人，Bruce Springsteen。'), '布魯斯是一位音樂人，Bruce Springsteen。');
  assert.equal(convertText('She combs her hair backstage.', '她在后台梳理头发。'), '她在後臺梳理頭髮。');
  assert.match(glossaryPrompt(['Blues and Grunge']), /blues = 布鲁斯/);
  assert.equal(relevantTerms(['Bruce Springsteen and a houseboat']).length, 0);
});

test('local conversion generates a complete deterministic locale with source and glossary provenance', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'mmzh-convert-'));
  t.after(() => rm(rootDir, { recursive: true }));
  await mkdir(join(rootDir, '.cache/source'), { recursive: true });
  await mkdir(join(rootDir, 'generated/locales'), { recursive: true });
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(['Blues', 'Grunge']));
  const simplified = { Blues: '布鲁斯', Grunge: '垃圾摇滚' };
  await writeFile(join(rootDir, 'generated/locales/zh-Hans.json'), JSON.stringify(simplified));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Conversion must never use the network'); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const meta = await convertToTraditional({ rootDir, log() {} });
  assert.equal(meta.complete, true);
  assert.deepEqual(meta.converter, CONVERTER);
  assert.equal(meta.terminologyHash, TERMINOLOGY_HASH);
  assert.equal(meta.simplifiedHash, hashLocale(simplified));
  assert.equal(hashLocale({ a: '甲', b: '乙' }), hashLocale({ b: '乙', a: '甲' }));
  const traditional = JSON.parse(await readFile(join(rootDir, 'generated/locales/zh-Hant.json')));
  assert.deepEqual(traditional, { Blues: '藍調', Grunge: '油漬搖滾' });
  assert.deepEqual(await convertToTraditional({ rootDir, log() {} }), meta);
  await writeFile(join(rootDir, 'generated/locales/zh-Hans.json'), JSON.stringify({ Blues: '布鲁斯' }));
  const partial = await convertToTraditional({ rootDir, log() {} });
  assert.equal(partial.complete, false);
  assert.equal(partial.converted, 1);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir, 'generated/locales/zh-Hant.json'))), { Blues: '藍調' });
});
