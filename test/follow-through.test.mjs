import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsage } from '../lib/benchmark-cost.mjs';
import { loadTranslationContexts } from '../lib/translation-context.mjs';
import { TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { TRANSLATION_PROMPT_TEMPLATE_HASH } from '../lib/translator.mjs';
import { atomicJson, shardForText } from '../scripts/translate.mjs';
import { FROZEN_FILES, prepareProduction } from '../scripts/production.mjs';
import { acquireFollowThroughLock, planRecovery, readFollowThroughStatus, RECOVERY_POLICY, runFollowThrough, unresolvedRecords } from '../scripts/follow-through.mjs';

const realRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const recordFile = (rootDir, index, id) => join(rootDir, `generated/translation-requests/zh-Hans-${index}-of-8/${id}.json`);

async function fixture(t, failedShards = [1]) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-follow-through-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const file of FROZEN_FILES) {
    await mkdir(dirname(join(rootDir, file)), { recursive: true });
    await writeFile(join(rootDir, file), `fixture ${file}`);
  }
  await cp(join(realRoot, 'data/terminology.json'), join(rootDir, 'data/terminology.json'));
  const source = Array.from({ length: 400 }, (_, index) => `Unique source fragment ${index}`);
  await atomicJson(join(rootDir, '.cache/source/strings.json'), source);
  await writeFile(join(rootDir, 'generated/site/index.html'), '<html><body>Reference document.</body></html>');
  await atomicJson(join(rootDir, 'generated/site/master-genrelist.json'), {});
  await atomicJson(join(rootDir, 'generated/locales/zh-Hans.json'), {});
  const prepared = await prepareProduction({ rootDir, authSourceFile: join(rootDir, 'key-not-read') });
  await atomicJson(join(rootDir, 'generated/production/status.json'), { ...prepared, state: 'failed' });
  const manifest = await json(join(rootDir, 'generated/production/manifest.json'));
  const contexts = await loadTranslationContexts({ rootDir, source });
  const identity = { sourceHash: manifest.frozen.sourceHash, model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort,
    maxTokens: manifest.config.maxTokens, baseUrl: manifest.config.baseUrl, promptTemplateHash: TRANSLATION_PROMPT_TEMPLATE_HASH,
    terminologyHash: TERMINOLOGY_HASH, contextsHash: hash(JSON.stringify([...contexts])) };
  const shards = {};
  const recordsByShard = {};
  for (let index = 1; index <= 8; index += 1) {
    shards[index] = await json(join(rootDir, `generated/shards/zh-Hans-${index}-of-8.json`));
    recordsByShard[index] = [];
    if (!failedShards.includes(index)) continue;
    const texts = source.filter((text) => shardForText(text, 8) === index).slice(0, 20);
    const rawUsage = { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens_details: { reasoning_tokens: 150 } };
    const record = { type: 'failed', requestId: randomUUID(), httpStatus: 200, finishReason: 'stop', errorCode: 'INVALID_TRANSLATION',
      model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort, maxTokens: manifest.config.maxTokens, timeoutMs: manifest.config.timeoutMs,
      returnedModel: manifest.config.model, returnedEffort: null, language: 'zh-Hans',
      sourceCount: texts.length, sourceHash: hash(JSON.stringify(texts)), textHashes: texts.map(hash),
      contextHashes: texts.map((text) => hash(contexts.get(text) ?? '')), identity, identityHash: hash(JSON.stringify(identity)),
      rawUsage, normalizedUsage: normalizeUsage('deepseek', rawUsage) };
    recordsByShard[index].push(record);
    await atomicJson(recordFile(rootDir, index, record.requestId), record);
  }
  const ledger = { schemaVersion: 1, state: 'monitoring', manifestHash: hash(JSON.stringify(manifest)), policy: { ...RECOVERY_POLICY }, reservedRequests: 0, attempts: [], restarts: [] };
  return { rootDir, manifest, source, contexts, identity, shards, recordsByShard, ledger };
}

test('policy accepts one exact known-usage schema failure and rejects changed batch, unknown usage, auth, and repeated failures', async (t) => {
  const input = await fixture(t);
  assert.equal(planRecovery(input)[0].sourceCount, 20);
  const original = structuredClone(input.recordsByShard[1][0]);
  for (const [changes, code] of [
    [{ type: 'started' }, 'UNREVIEWABLE_FAILURE'],
    [{ httpStatus: 401, errorCode: 'API_AUTH_FAILED' }, 'UNREVIEWABLE_FAILURE'],
    [{ errorCode: 'API_TIMEOUT' }, 'UNREVIEWABLE_FAILURE'],
    [{ normalizedUsage: null }, 'UNKNOWN_USAGE'],
    [{ rawUsage: { ...original.rawUsage, total_tokens: 301 } }, 'UNKNOWN_USAGE'],
    [{ rawUsage: { ...original.rawUsage, prompt_cache_miss_tokens: 99 } }, 'UNKNOWN_USAGE'],
    [{ reasoningEffort: 'high' }, 'CONFIGURATION_MISMATCH'],
    [{ textHashes: [...original.textHashes].reverse() }, 'BATCH_CHANGED'],
  ]) {
    input.recordsByShard[1] = [{ ...original, ...changes }];
    assert.throws(() => planRecovery(input), { code });
  }
  const repeated = { ...original, requestId: randomUUID(), reviewedPreviousRequestIds: [original.requestId] };
  input.recordsByShard[1] = [original, repeated];
  assert.throws(() => planRecovery(input), { code: 'RETRY_EXHAUSTED' });
});

test('historical manual review may split a failed batch, while it remains excluded from automatic retry', async (t) => {
  const input = await fixture(t, [1, 2]);
  const original = input.recordsByShard[1][0];
  const manual = { ...original, requestId: randomUUID(), type: 'completed', sourceCount: 10,
    textHashes: original.textHashes.slice(0, 10), sourceHash: hash('manual-reviewed-smaller-batch'), reviewedPreviousRequestIds: [original.requestId] };
  input.recordsByShard[1].push(manual);
  assert.equal(unresolvedRecords(input.recordsByShard[1]).length, 0);
  assert.deepEqual(planRecovery(input).map((candidate) => candidate.index), [2]);
});

test('durable request cap and interrupted reservations cannot be reset by restarting the supervisor', async (t) => {
  const input = await fixture(t);
  input.ledger.reservedRequests = 1;
  input.ledger.attempts = [{ index: 1, failedRequestId: randomUUID(), batchKey: hash('old'), failedRecordHash: hash('record'), state: 'reserved' }];
  assert.throws(() => planRecovery(input), { code: 'PRIOR_RETRY_UNRESOLVED' });
  await atomicJson(join(input.rootDir, 'generated/production/follow-through.json'), input.ledger);
  let calls = 0;
  const result = await runFollowThrough({ rootDir: input.rootDir, manageSignals: false, queryService: async () => { calls += 1; return { state: 'failed', pid: 0 }; }, runChild: async () => { calls += 1; } });
  assert.equal(result.state, 'needs-review');
  assert.equal(result.reservedRequests, 1);
  assert.equal(calls, 0);
  const gate = structuredClone(input);
  gate.ledger.attempts = Array.from({ length: 20 }, (_, index) => ({ index: 1, failedRequestId: randomUUID(), batchKey: hash(`old-${index}`), failedRecordHash: hash(`record-${index}`), state: 'completed' }));
  gate.ledger.reservedRequests = 20;
  assert.throws(() => planRecovery(gate), { code: 'RECOVERY_CAP' });
});

test('successful bounded recovery persists reservations, caps concurrency at two, and restarts only the existing service', async (t) => {
  const input = await fixture(t, [1, 2, 3]);
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let restarts = 0;
  let releaseWave;
  const wave = new Promise((resolve) => { releaseWave = resolve; });
  const result = await runFollowThrough({
    rootDir: input.rootDir, manageSignals: false, log: () => {}, sleep: async () => {},
    queryService: async () => ({ state: restarts ? 'missing' : 'failed', pid: 0 }),
    runChild: async (_command, args, options) => {
      calls += 1; active += 1; maximum = Math.max(maximum, active); if (active === 2) releaseWave();
      const saved = await json(join(input.rootDir, 'generated/production/follow-through.json'));
      assert.ok(saved.attempts.some((attempt) => attempt.index === options.index && attempt.state === 'reserved'));
      assert.equal(args[args.indexOf('--limit') + 1], '20');
      assert.ok(args.includes('--retry-failed'));
      assert.equal(options.env.DEEPSEEK_API_KEY_FILE, input.manifest.authSourceFile);
      assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
      assert.equal(options.env.DEEPSEEK_MODEL, 'deepseek-v4-pro');
      await wave;
      const original = input.recordsByShard[options.index][0];
      const record = { ...original, type: 'completed', requestId: randomUUID(), errorCode: null, reviewedPreviousRequestIds: [original.requestId], translations: original.textHashes.map(() => '已保存译文') };
      await atomicJson(recordFile(input.rootDir, options.index, record.requestId), record);
      const shard = input.shards[options.index];
      for (const text of input.source.filter((value) => original.textHashes.includes(hash(value)))) shard.translations[text] = '已保存译文';
      await atomicJson(join(input.rootDir, `generated/shards/zh-Hans-${options.index}-of-8.json`), shard);
      active -= 1;
      return { code: 0 };
    },
    resumeService: async () => {
      restarts += 1;
      assert.equal(active, 0);
      // Simulate the existing service finishing the remaining translation and final verification.
      for (let index = 1; index <= 8; index += 1) {
        const shard = input.shards[index];
        for (const text of input.source.filter((value) => shardForText(value, 8) === index)) shard.translations[text] ??= '完成译文';
        await atomicJson(join(input.rootDir, `generated/shards/zh-Hans-${index}-of-8.json`), shard);
      }
      const status = await json(join(input.rootDir, 'generated/production/status.json'));
      await atomicJson(join(input.rootDir, 'generated/production/status.json'), { ...status, state: 'completed', finalization: ['merge', 'convert', 'build', 'test:browser'].map((script) => ({ script, exitCode: 0 })) });
    },
  });
  assert.equal(result.state, 'completed');
  assert.equal(calls, 3);
  assert.equal(maximum, 2);
  assert.equal(restarts, 1);
  assert.equal(result.reservedRequests, 3);
  assert.ok(result.attempts.every((attempt) => attempt.state === 'completed' && attempt.completedRecordHash));
});

test('failed exact retry consumes its reservation and never restarts or schedules a second attempt', async (t) => {
  const input = await fixture(t);
  let calls = 0;
  let restarts = 0;
  const run = () => runFollowThrough({ rootDir: input.rootDir, manageSignals: false, log: () => {}, queryService: async () => ({ state: 'failed', pid: 0 }),
    runChild: async () => { calls += 1; return { code: 1 }; }, resumeService: async () => { restarts += 1; } });
  const result = await run();
  assert.equal(result.state, 'needs-review');
  assert.equal(result.reservedRequests, 1);
  assert.equal(result.errorCode, 'RETRY_FAILED');
  assert.equal((await run()).state, 'needs-review');
  assert.equal(calls, 1);
  assert.equal(restarts, 0);
});

test('active shard locks stop recovery, supervisor locks cannot be taken over, and status remains read-only', async (t) => {
  const input = await fixture(t);
  const before = await readFollowThroughStatus({ rootDir: input.rootDir });
  assert.equal(before.recovery.state, 'not-started');
  await assert.rejects(readFile(join(input.rootDir, 'generated/production/follow-through.json')), { code: 'ENOENT' });
  const release = await acquireFollowThroughLock(input.rootDir);
  await assert.rejects(acquireFollowThroughLock(input.rootDir), { code: 'SUPERVISOR_LOCKED' });
  await release();
  await mkdir(join(input.rootDir, 'generated/translation-locks/zh-Hans-2-of-8'), { recursive: true });
  let called = false;
  const result = await runFollowThrough({ rootDir: input.rootDir, manageSignals: false, log: () => {}, queryService: async () => ({ state: 'failed', pid: 0 }), runChild: async () => { called = true; } });
  assert.equal(result.errorCode, 'SHARD_LOCKED');
  assert.equal(called, false);
});

test('stopping a monitor does not stop or restart the translation service', async (t) => {
  const input = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const result = await runFollowThrough({ rootDir: input.rootDir, signal: controller.signal, manageSignals: false, log: () => {},
    queryService: async () => ({ state: 'active', pid: 12345 }), sleep: async () => controller.abort(),
    runChild: async () => { calls += 1; }, resumeService: async () => { calls += 1; } });
  assert.equal(result.state, 'interrupted');
  assert.equal(calls, 0);
  assert.equal(result.reservedRequests, 0);
});

test('stopping an owned retry signals only its tracked child and retains the paid reservation', async (t) => {
  const input = await fixture(t);
  const controller = new AbortController();
  const signals = [];
  let restarted = false;
  const result = await runFollowThrough({ rootDir: input.rootDir, signal: controller.signal, manageSignals: false, log: () => {},
    queryService: async () => ({ state: 'failed', pid: 0 }), resumeService: async () => { restarted = true; },
    runChild: async (_command, _args, options) => {
      const child = { exitCode: null, signalCode: null, killed: false,
        kill(signal) { signals.push(signal); this.killed = true; return true; } };
      options.activeChildren.add(child);
      controller.abort();
      options.activeChildren.delete(child);
      return { code: 130 };
    },
  });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.reservedRequests, 1);
  assert.equal(result.attempts[0].state, 'interrupted');
  assert.equal(restarted, false);
});

test('false complete status and successful retry with missing usage both require review', async (t) => {
  const first = await fixture(t);
  const status = await json(join(first.rootDir, 'generated/production/status.json'));
  await atomicJson(join(first.rootDir, 'generated/production/status.json'), { ...status, state: 'completed' });
  const badCompletion = await runFollowThrough({ rootDir: first.rootDir, manageSignals: false, log: () => {}, queryService: async () => ({ state: 'inactive', pid: 0 }) });
  assert.equal(badCompletion.errorCode, 'FALSE_COMPLETION');

  const second = await fixture(t);
  let restarted = false;
  const unknownUsage = await runFollowThrough({ rootDir: second.rootDir, manageSignals: false, log: () => {},
    queryService: async () => ({ state: 'failed', pid: 0 }), resumeService: async () => { restarted = true; },
    runChild: async () => {
      const original = second.recordsByShard[1][0];
      const record = { ...original, type: 'completed', requestId: randomUUID(), errorCode: null,
        rawUsage: null, normalizedUsage: null, reviewedPreviousRequestIds: [original.requestId], translations: original.textHashes.map(() => '译文') };
      await atomicJson(recordFile(second.rootDir, 1, record.requestId), record);
      for (const text of second.source.filter((value) => original.textHashes.includes(hash(value)))) second.shards[1].translations[text] = '译文';
      await atomicJson(join(second.rootDir, 'generated/shards/zh-Hans-1-of-8.json'), second.shards[1]);
      return { code: 0 };
    },
  });
  assert.equal(unknownUsage.state, 'needs-review');
  assert.equal(unknownUsage.reservedRequests, 1);
  assert.equal(restarted, false);
});

test('an independently resumed service is observed without stopping or starting it again', async (t) => {
  const input = await fixture(t);
  const controller = new AbortController();
  let queries = 0;
  let starts = 0;
  const result = await runFollowThrough({ rootDir: input.rootDir, signal: controller.signal, manageSignals: false, log: () => {},
    queryService: async () => (++queries <= 2 ? { state: 'failed', pid: 0 } : { state: 'active', pid: 12345 }),
    resumeService: async () => { starts += 1; }, sleep: async () => controller.abort(),
    runChild: async () => {
      const original = input.recordsByShard[1][0];
      const record = { ...original, type: 'completed', requestId: randomUUID(), errorCode: null,
        reviewedPreviousRequestIds: [original.requestId], translations: original.textHashes.map(() => '译文') };
      await atomicJson(recordFile(input.rootDir, 1, record.requestId), record);
      for (const text of input.source.filter((value) => original.textHashes.includes(hash(value)))) input.shards[1].translations[text] = '译文';
      await atomicJson(join(input.rootDir, 'generated/shards/zh-Hans-1-of-8.json'), input.shards[1]);
      return { code: 0 };
    },
  });
  assert.equal(starts, 0);
  assert.equal(result.restarts[0].state, 'already-active');
  assert.equal(result.attempts[0].state, 'completed');
  assert.equal(result.state, 'interrupted');
});
