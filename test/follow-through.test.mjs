import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsage } from '../lib/benchmark-cost.mjs';
import { loadTranslationContexts } from '../lib/translation-context.mjs';
import { SIMPLIFIED_TERMINOLOGY_HASH, TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { TRANSLATION_PROMPT_TEMPLATE_HASH, TRANSLATION_PROMPT_VERSION } from '../lib/translator.mjs';
import { atomicJson, shardForText } from '../scripts/translate.mjs';
import { FROZEN_FILES, prepareProduction } from '../scripts/production.mjs';
import { acknowledgeManualRecovery, acquireFollowThroughLock, planRecovery, readFollowThroughStatus, RECOVERY_POLICY, runFollowThrough, unresolvedRecords, validateManualResolution } from '../scripts/follow-through.mjs';

const realRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const recordFile = (rootDir, index, id) => join(rootDir, `generated/translation-requests/zh-Hans-${index}-of-8/${id}.json`);
const stopped = async () => ({ state: 'failed', pid: 0 });

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

async function manuallyRecoveredFixture(t) {
  const input = await fixture(t, [1, 2, 3, 4, 5]);
  for (const records of Object.values(input.recordsByShard)) for (const record of records) {
    Object.assign(record, { startedAt: '2026-10-13T00:00:00.000Z', finishedAt: '2026-10-13T00:00:01.000Z',
      promptHash: hash('original prompt'), promptVersion: TRANSLATION_PROMPT_VERSION,
      promptTemplateHash: TRANSLATION_PROMPT_TEMPLATE_HASH, terminologyHash: SIMPLIFIED_TERMINOLOGY_HASH });
  }
  const candidates = planRecovery(input);
  for (const candidate of candidates) {
    const index = candidate.index;
    const original = input.recordsByShard[index][0];
    const retry = { ...original, requestId: randomUUID(), reviewedPreviousRequestIds: [original.requestId],
      startedAt: '2026-10-13T00:00:03.000Z', finishedAt: '2026-10-13T00:00:04.000Z',
      ...(index === 5 ? {} : { type: 'completed', errorCode: null, translations: original.textHashes.map(() => '自动补试译文') }) };
    input.recordsByShard[index].push(retry);
    const entry = { ...candidate, state: index === 5 ? 'needs-review' : 'completed', reservedAt: '2026-10-13T00:00:02.000Z',
      finishedAt: '2026-10-13T00:00:05.000Z', exitCode: index === 5 ? 1 : 0, newRequestIds: [retry.requestId],
      ...(index === 5 ? {} : { completedRequestId: retry.requestId, completedRecordHash: hash(JSON.stringify(retry)) }) };
    input.ledger.attempts.push(entry);
    if (index === 5) {
      for (let half = 0; half < 2; half += 1) {
        const textHashes = original.textHashes.slice(half * 10, half * 10 + 10);
        const texts = textHashes.map((textHash) => input.source.find((text) => hash(text) === textHash));
        input.recordsByShard[index].push({ ...original, requestId: randomUUID(), type: 'completed', errorCode: null,
          startedAt: `2026-10-13T00:00:${10 + half * 2}.000Z`, finishedAt: `2026-10-13T00:00:${11 + half * 2}.000Z`,
          sourceCount: 10, sourceHash: hash(JSON.stringify(texts)), textHashes, contextHashes: texts.map((text) => hash(input.contexts.get(text) ?? '')),
          promptHash: hash(`manual half ${half}`), translations: texts.map((text) => `人工拆批译文 ${text}`),
          ...(half === 0 ? { reviewedPreviousRequestIds: [retry.requestId] } : {}) });
      }
    }
    for (const record of input.recordsByShard[index]) {
      await atomicJson(recordFile(input.rootDir, index, record.requestId), record);
      if (record.type === 'completed') record.textHashes.forEach((value, offset) => {
        input.shards[index].translations[input.source.find((text) => hash(text) === value)] = record.translations[offset];
      });
    }
    await atomicJson(join(input.rootDir, `generated/shards/zh-Hans-${index}-of-8.json`), input.shards[index]);
  }
  Object.assign(input.ledger, { state: 'needs-review', errorCode: 'RETRY_FAILED', reservedRequests: 5 });
  await atomicJson(join(input.rootDir, 'generated/production/follow-through.json'), input.ledger);
  return input;
}

const acknowledge = (input, options = {}) => acknowledgeManualRecovery({ rootDir: input.rootDir,
  failedRequestId: input.ledger.attempts.at(-1).failedRequestId, queryService: stopped, queryMonitor: stopped, ...options });

test('manual acknowledgement proves 10+10 outputs, retains the failed fifth attempt and all automatic reservations', async (t) => {
  const input = await manuallyRecoveredFixture(t);
  const before = structuredClone(input.ledger.attempts.at(-1));
  const originals = await Promise.all(input.recordsByShard[5].map((record) => readFile(recordFile(input.rootDir, 5, record.requestId), 'utf8')));
  const ledger = await acknowledge(input);
  const entry = ledger.attempts.at(-1);
  assert.equal(ledger.state, 'monitoring');
  assert.equal(ledger.reservedRequests, 5);
  assert.equal(ledger.attempts.length, 5);
  const { manualResolution, manualResolutionHash, ...retained } = entry;
  assert.deepEqual(retained, before);
  assert.equal(entry.state, 'needs-review');
  assert.equal(manualResolution.completedRecords.length, 2);
  assert.equal(manualResolution.failedRetryRecords.length, 1);
  assert.equal(manualResolution.previousLedgerErrorCode, 'RETRY_FAILED');
  assert.equal(manualResolutionHash, hash(JSON.stringify(manualResolution)));
  assert.deepEqual(await Promise.all(input.recordsByShard[5].map((record) => readFile(recordFile(input.rootDir, 5, record.requestId), 'utf8'))), originals);
  validateManualResolution(entry, input);
  assert.throws(() => planRecovery({ ...input, ledger }), { code: 'NO_ELIGIBLE_FAILURE' });
  ledger.reservedRequests = 0;
  assert.throws(() => planRecovery({ ...input, ledger }), { code: 'LEDGER_MISMATCH' });
});

test('manual acknowledgement refuses incomplete, duplicate, changed, unknown-cost or unreviewed evidence without writing the ledger', async (t) => {
  for (const scenario of ['original', 'retry-hash', 'missing-half', 'duplicate', 'identity', 'context', 'usage', 'unreviewed', 'unresolved-other', 'saved-output', 'early-output']) {
    await t.test(scenario, async (t) => {
      const input = await manuallyRecoveredFixture(t);
      const entry = input.ledger.attempts.at(-1);
      const records = input.recordsByShard[5];
      const first = records[2];
      let changed = first;
      if (scenario === 'original') { changed = records[0]; changed.finishReason = 'length'; }
      if (scenario === 'retry-hash') {
        entry.newRequestRecords = [{ requestId: records[1].requestId, recordHash: hash('different retry') }];
        await atomicJson(join(input.rootDir, 'generated/production/follow-through.json'), input.ledger);
      }
      if (scenario === 'missing-half') await rm(recordFile(input.rootDir, 5, records[3].requestId));
      if (scenario === 'duplicate') {
        const duplicate = { ...first, requestId: randomUUID() };
        await atomicJson(recordFile(input.rootDir, 5, duplicate.requestId), duplicate);
      }
      if (scenario === 'identity') first.identityHash = hash('different identity');
      if (scenario === 'context') first.contextHashes[0] = hash('changed context');
      if (scenario === 'usage') first.rawUsage = null;
      if (scenario === 'unreviewed') delete first.reviewedPreviousRequestIds;
      if (scenario === 'unresolved-other') {
        const other = { ...records[0], requestId: randomUUID() };
        await atomicJson(recordFile(input.rootDir, 6, other.requestId), other);
      }
      if (scenario === 'saved-output') {
        const text = input.source.find((value) => hash(value) === first.textHashes[0]);
        input.shards[5].translations[text] = 'different saved output';
        await atomicJson(join(input.rootDir, 'generated/shards/zh-Hans-5-of-8.json'), input.shards[5]);
      }
      if (scenario === 'early-output') first.startedAt = records[0].startedAt;
      await atomicJson(recordFile(input.rootDir, 5, changed.requestId), changed);
      const before = await readFile(join(input.rootDir, 'generated/production/follow-through.json'), 'utf8');
      await assert.rejects(acknowledge(input));
      assert.equal(await readFile(join(input.rootDir, 'generated/production/follow-through.json'), 'utf8'), before);
    });
  }
});

test('manual acknowledgement requires both stopped services and empty coordination and shard locks', async (t) => {
  const input = await manuallyRecoveredFixture(t);
  const before = await readFile(join(input.rootDir, 'generated/production/follow-through.json'), 'utf8');
  await assert.rejects(acknowledge(input, { queryService: async () => ({ state: 'active', pid: 123 }) }), { code: 'SERVICE_BECAME_ACTIVE' });
  await assert.rejects(acknowledge(input, { queryMonitor: async () => ({ state: 'active', pid: 123 }) }), { code: 'SERVICE_BECAME_ACTIVE' });
  let queries = 0;
  await assert.rejects(acknowledge(input, { queryService: async () => (++queries === 3 ? { state: 'active', pid: 123 } : { state: 'failed', pid: 0 }) }), { code: 'SERVICE_BECAME_ACTIVE' });
  for (const [path, code] of [['generated/production/follow-through-lock', 'SUPERVISOR_LOCKED'], ['generated/production/lock', 'PRODUCTION_LOCKED'], ['generated/translation-locks/shard', 'SHARD_LOCKED']]) {
    await mkdir(join(input.rootDir, path), { recursive: true });
    await assert.rejects(acknowledge(input), { code });
    await rm(join(input.rootDir, path), { recursive: true });
  }
  await assert.rejects(acknowledge(input, { failedRequestId: input.recordsByShard[5][1].requestId }), { code: 'MANUAL_TARGET_INVALID' });
  assert.equal(await readFile(join(input.rootDir, 'generated/production/follow-through.json'), 'utf8'), before);
});

test('every later monitor iteration revalidates manual journal hashes and saved translations without model calls', async (t) => {
  for (const scenario of ['journal', 'shard', 'resolution']) await t.test(scenario, async (t) => {
    const input = await manuallyRecoveredFixture(t);
    const ledger = await acknowledge(input);
    if (scenario === 'resolution') {
      ledger.attempts.at(-1).manualResolution.completedRecords.pop();
      await atomicJson(join(input.rootDir, 'generated/production/follow-through.json'), ledger);
    }
    let calls = 0;
    let iterations = 0;
    const result = await runFollowThrough({ rootDir: input.rootDir, manageSignals: false, log: () => {},
      queryService: async () => ({ state: 'active', pid: 123 }),
      runChild: async () => { calls += 1; }, resumeService: async () => { calls += 1; },
      sleep: async () => {
        assert.equal(++iterations, 1);
        const record = input.recordsByShard[5][2];
        if (scenario === 'journal') {
          record.translations[0] = 'changed';
          await atomicJson(recordFile(input.rootDir, 5, record.requestId), record);
        } else {
          const text = input.source.find((value) => hash(value) === record.textHashes[0]);
          input.shards[5].translations[text] = 'changed';
          await atomicJson(join(input.rootDir, 'generated/shards/zh-Hans-5-of-8.json'), input.shards[5]);
        }
      } });
    assert.equal(result.state, 'needs-review');
    assert.equal(result.reservedRequests, 5);
    assert.equal(result.errorCode, { journal: 'JOURNAL_TAMPERED', shard: 'MANUAL_OUTPUT_MISMATCH', resolution: 'MANUAL_RESOLUTION_CHANGED' }[scenario]);
    assert.equal(calls, 0);
  });
});
