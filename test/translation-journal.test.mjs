import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTranslationLock, createTranslationJournal, readTranslationKey } from '../lib/translation-journal.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const requestId = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-ledger-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return { rootDir, scope: 'zh-Hans-1-of-8', identity: { sourceHash: 'fixture', model: 'deepseek-v4-pro', reasoningEffort: 'max' }, source: ['Source sentence.'] };
}

test('dedicated key file overrides ambient key and failures never echo its contents', async t => {
  const { rootDir } = await fixture(t);
  const apiKeyFile = join(rootDir, 'secret');
  await writeFile(apiKeyFile, 'sk-dedicated-test\n');
  assert.equal(await readTranslationKey({ apiKey: 'sk-old-test', apiKeyFile }), 'sk-dedicated-test');
  await writeFile(apiKeyFile, 'sensitive malformed value');
  await assert.rejects(readTranslationKey({ apiKeyFile }), error => !error.message.includes('sensitive'));
  await assert.rejects(readTranslationKey({ apiKeyFile: join(rootDir, 'missing') }), /Cannot read/);
});

test('same shard cannot run concurrently and lock releases for normal resumption', async t => {
  const { rootDir, scope } = await fixture(t);
  const release = await acquireTranslationLock(rootDir, scope);
  await assert.rejects(acquireTranslationLock(rootDir, scope), /lock exists/);
  const otherRelease = await acquireTranslationLock(rootDir, 'zh-Hans-2-of-8');
  await otherRelease();
  await release();
  await (await acquireTranslationLock(rootDir, scope))();
});

test('interrupted or failed requests block automatic paid retries and preserve unknown usage', async t => {
  const settings = await fixture(t);
  const journal = await createTranslationJournal(settings);
  await journal.record({ type: 'started', requestId, startedAt: '2026-10-13T11:00:00Z' });
  await assert.rejects(createTranslationJournal(settings), /require review/);
  const record = JSON.parse(await readFile(join(settings.rootDir, 'generated/translation-requests', settings.scope, `${requestId}.json`), 'utf8'));
  assert.equal(record.normalizedUsage, null);
  assert.equal(record.cost, null);
  const reviewed = await createTranslationJournal({ ...settings, retryFailed: true });
  await reviewed.record({ type: 'completed', requestId: '22222222-2222-4222-8222-222222222222', textHashes: [hash(settings.source[0])], translations: ['译文。'] });
  assert.deepEqual({ ...(await createTranslationJournal(settings)).recovered }, { 'Source sentence.': '译文。' });
});

test('completed paid response can restore lost exports only with matching frozen identity', async t => {
  const settings = await fixture(t);
  const journal = await createTranslationJournal(settings);
  await journal.record({ type: 'completed', requestId, textHashes: [hash(settings.source[0])], translations: ['译文。'] });
  assert.equal((await createTranslationJournal(settings)).recovered[settings.source[0]], '译文。');
  assert.deepEqual({ ...(await createTranslationJournal({ ...settings, identity: { ...settings.identity, reasoningEffort: 'high' } })).recovered }, {});
});
