import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  acquireProductionLock, executeProduction, FROZEN_FILES, parseProductionArguments,
  prepareProduction, readProductionStatus, runWorkerPool, summarizeRequestJournals,
  runChildProcess, signalActiveChildren,
} from '../scripts/production.mjs';
import { atomicJson, loadSource, shardForText } from '../scripts/translate.mjs';

async function fixture(t, { seedCount = 23 } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-production-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const file of FROZEN_FILES) {
    await mkdir(dirname(join(rootDir, file)), { recursive: true });
    await writeFile(join(rootDir, file), `${file}\n`);
  }
  const source = Array.from({ length: 200 }, (_, index) => `Production source fragment ${index}`);
  await atomicJson(join(rootDir, '.cache/source/strings.json'), source);
  await atomicJson(join(rootDir, 'data/terminology.json'), { version: 1, terms: [] });
  await atomicJson(join(rootDir, 'generated/locales/zh-Hans.json'), Object.fromEntries(source.slice(0, seedCount).map((text) => [text, `现有：${text}`])));
  return { rootDir, source, authSourceFile: join(rootDir, 'nonexistent-key-file') };
}

const shardPath = (rootDir, index) => join(rootDir, `generated/shards/zh-Hans-${index}-of-8.json`);
async function completeShard(rootDir, source, index) {
  const file = shardPath(rootDir, index);
  const wrapper = JSON.parse(await readFile(file, 'utf8'));
  for (const text of source.filter((value) => shardForText(value, 8) === index)) wrapper.translations[text] ??= `新增：${text}`;
  await atomicJson(file, wrapper);
}

test('prepare partitions every existing translation without reading a key; status and repeat preparation preserve outputs', async (t) => {
  const options = await fixture(t);
  const prepared = await prepareProduction(options);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.translated, 23);
  assert.equal(prepared.total, 200);
  assert.equal(prepared.requests.total, 0);
  const manifestPath = join(options.rootDir, 'generated/production/manifest.json');
  const manifestBytes = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.authSourceFile, options.authSourceFile);
  assert.equal(manifest.config.model, 'deepseek-v4-pro');
  assert.equal(manifest.config.reasoningEffort, 'max');
  assert.equal(manifest.initialSeed.count, 23);
  assert.equal(Object.keys(manifest.frozen.files).length, FROZEN_FILES.length);
  const values = {};
  const bytes = [];
  for (let index = 1; index <= 8; index += 1) {
    bytes.push(await readFile(shardPath(options.rootDir, index), 'utf8'));
    const wrapper = JSON.parse(bytes[index - 1]);
    for (const [source, translated] of Object.entries(wrapper.translations)) {
      assert.equal(shardForText(source, 8), index);
      assert.equal(Object.hasOwn(values, source), false);
      values[source] = translated;
    }
  }
  assert.equal(Object.keys(values).length, 23);
  await readProductionStatus(options);
  await prepareProduction(options);
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBytes);
  for (let index = 1; index <= 8; index += 1) assert.equal(await readFile(shardPath(options.rootDir, index), 'utf8'), bytes[index - 1]);
});

test('prepare validates every shard and locale overlap before writing any output', async (t) => {
  const options = await fixture(t);
  const { sourceHash } = await loadSource(options.rootDir);
  const text = options.source[0];
  const index = shardForText(text, 8);
  const wrapper = { sourceHash, language: 'zh-Hans', shard: { index, count: 8 }, translations: { [text]: '冲突译文' } };
  await atomicJson(shardPath(options.rootDir, index), wrapper);
  const bytes = await readFile(shardPath(options.rootDir, index), 'utf8');
  await assert.rejects(prepareProduction(options), { code: 'SEED_CONFLICT' });
  assert.deepEqual(await readdir(join(options.rootDir, 'generated/shards')), [`zh-Hans-${index}-of-8.json`]);
  assert.equal(await readFile(shardPath(options.rootDir, index), 'utf8'), bytes);
});

test('frozen program changes block execution before any process launches', async (t) => {
  const options = await fixture(t);
  await prepareProduction(options);
  await writeFile(join(options.rootDir, 'lib/translator.mjs'), 'changed prompt\n');
  let called = false;
  await assert.rejects(executeProduction({ ...options, manageSignals: false, runChild: async () => { called = true; return { code: 0 }; } }), { code: 'FROZEN_INPUT_CHANGED' });
  assert.equal(called, false);
  assert.equal((await readProductionStatus(options)).state, 'prepared');
});

test('production directory lock refuses a second process and never takes over an existing lock', async (t) => {
  const options = await fixture(t);
  const release = await acquireProductionLock(options.rootDir);
  await assert.rejects(acquireProductionLock(options.rootDir), { code: 'PRODUCTION_LOCKED' });
  await assert.rejects(prepareProduction(options), { code: 'PRODUCTION_LOCKED' });
  assert.equal(JSON.parse(await readFile(join(options.rootDir, 'generated/production/lock/owner.json'), 'utf8')).pid, process.pid);
  await release();
  const nextRelease = await acquireProductionLock(options.rootDir);
  await nextRelease();
});

test('worker failure stops new launches and waits for already active work without retrying', async () => {
  const active = new Map();
  const starts = [];
  const poolPromise = runWorkerPool([1, 2, 3, 4, 5], {
    workers: 2,
    run: (item) => new Promise((resolve) => { starts.push(item); active.set(item, resolve); }),
  });
  assert.deepEqual(starts, [1, 2]);
  active.get(1)({ code: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1, 2]);
  let completed = false;
  poolPromise.then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  active.get(2)({ code: 0 });
  const result = await poolPromise;
  assert.equal(result.failed, true);
  assert.deepEqual(result.unstarted, [3, 4, 5]);
  assert.equal(result.results.length, 2);
});

test('stop signals reach only tracked live children and process cleanup removes their handles', async () => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, killed: false });
  const signals = [];
  child.kill = (signal) => { signals.push(signal); child.killed = true; return true; };
  const activeChildren = new Set();
  const promise = runChildProcess('node', ['mock-child'], { rootDir: '/tmp', env: {}, activeChildren, spawnImpl: () => child });
  assert.equal(activeChildren.has(child), true);
  assert.equal(signalActiveChildren(activeChildren), 1);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(signalActiveChildren(activeChildren), 0);
  child.exitCode = 130;
  child.emit('exit', 130, null);
  assert.deepEqual(await promise, { code: 130 });
  assert.equal(activeChildren.size, 0);

  const failedChild = new EventEmitter();
  const failure = runChildProcess('node', [], { rootDir: '/tmp', env: {}, activeChildren, spawnImpl: () => failedChild });
  failedChild.emit('error', new Error('Do not expose child internals'));
  assert.deepEqual(await failure, { code: 1, errorCode: 'PROCESS_START_FAILED' });
  assert.equal(activeChildren.size, 0);
});

test('execution skips completed shards, isolates credentials and settings, then verifies a strict complete build', async (t) => {
  const options = await fixture(t);
  await prepareProduction(options);
  await completeShard(options.rootDir, options.source, 1);
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
  const runChild = async (command, args, context) => {
    calls.push({ command, args, context });
    assert.equal(context.env.DEEPSEEK_API_KEY_FILE, options.authSourceFile);
    assert.equal(context.env.DEEPSEEK_API_KEY, undefined);
    assert.equal(context.env.DEEPSEEK_MAX_TOKENS, '32768');
    assert.equal(context.env.DEEPSEEK_TIMEOUT_MS, '600000');
    if (context.kind === 'translation') {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 3) releaseFirstWave();
      assert.equal(args[args.indexOf('--model') + 1], 'deepseek-v4-pro');
      assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'max');
      await firstWave;
      await completeShard(options.rootDir, options.source, context.index);
      active -= 1;
    } else assert.equal(active, 0);
    return { code: 0 };
  };
  const status = await executeProduction({ ...options, workers: 3, runChild, manageSignals: false, log: () => {} });
  assert.equal(status.state, 'completed');
  assert.equal(status.translated, 200);
  assert.equal(maxActive, 3);
  assert.deepEqual(calls.filter((call) => call.context.kind === 'translation').map((call) => call.context.index).sort(), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(calls.filter((call) => call.context.kind === 'finalization').map((call) => call.args), [['run', 'merge'], ['run', 'convert'], ['run', 'build'], ['run', 'test:browser']]);
  const count = calls.length;
  await executeProduction({ ...options, workers: 3, runChild, manageSignals: false, log: () => {} });
  assert.equal(calls.length, count);
});

test('failed worker preserves completed output, records partial state, and does not finalize', async (t) => {
  const options = await fixture(t);
  await prepareProduction(options);
  const calls = [];
  const status = await executeProduction({
    ...options, workers: 1, manageSignals: false, log: () => {},
    runChild: async (_command, _args, context) => {
      calls.push(context);
      const file = shardPath(options.rootDir, context.index);
      const wrapper = JSON.parse(await readFile(file, 'utf8'));
      const text = options.source.find((source) => shardForText(source, 8) === context.index && !Object.hasOwn(wrapper.translations, source));
      wrapper.translations[text] = '失败前已保存';
      await atomicJson(file, wrapper);
      return { code: 1 };
    },
  });
  assert.equal(status.state, 'failed');
  assert.equal(status.translated, 24);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'translation');
  assert.deepEqual(status.unstartedShards, [2, 3, 4, 5, 6, 7, 8]);
});

test('successful process exit with incomplete shard is a failure, and browser verification is required for completion', async (t) => {
  const options = await fixture(t);
  await prepareProduction(options);
  let status = await executeProduction({ ...options, workers: 1, manageSignals: false, log: () => {}, runChild: async () => ({ code: 0 }) });
  assert.equal(status.state, 'failed');
  assert.equal(status.shards[0].errorCode, 'SHARD_INCOMPLETE');
  for (let index = 1; index <= 8; index += 1) await completeShard(options.rootDir, options.source, index);
  const scripts = [];
  status = await executeProduction({ ...options, manageSignals: false, log: () => {}, runChild: async (_command, _args, context) => {
    assert.equal(context.kind, 'finalization');
    scripts.push(context.script);
    return { code: context.script === 'test:browser' ? 1 : 0 };
  } });
  assert.deepEqual(scripts, ['merge', 'convert', 'build', 'test:browser']);
  assert.equal(status.translationComplete, true);
  assert.equal(status.state, 'failed');
  assert.equal(status.errorCode, 'FINALIZATION_FAILED');
});

test('journal summary counts every attempt, retains unknown costs, and excludes different source snapshots', async (t) => {
  const { rootDir } = await fixture(t);
  const sourceHash = 'current-source';
  const records = [
    { requestId: 'request-a', type: 'completed', identity: { sourceHash }, normalizedUsage: { input: 100, cacheRead: 20, cacheWrite: 0, output: 200, reasoning: 140, total: 300 }, cost: { usd: { min: 0.1, max: 0.1 }, cny: { min: 0.7, max: 0.7 } } },
    { requestId: 'request-b', type: 'failed', identity: { sourceHash }, normalizedUsage: null, cost: null },
    { requestId: 'request-c', type: 'started', identity: { sourceHash }, normalizedUsage: null, cost: null },
    { requestId: 'request-d', type: 'failed', identity: { sourceHash }, normalizedUsage: { input: 50, cacheRead: 0, cacheWrite: null, output: 70, reasoning: null, total: 120 }, cost: null },
    { requestId: 'unrelated', type: 'completed', identity: { sourceHash: 'other-source' }, normalizedUsage: { input: 9999999, output: 9999999 } },
  ];
  for (const record of records) await atomicJson(join(rootDir, `generated/translation-requests/zh-Hans-1-of-8/${record.requestId}.json`), record);
  const summary = await summarizeRequestJournals(rootDir, sourceHash);
  assert.equal(summary.total, 4);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.excludedSourceMismatch, 1);
  assert.equal(summary.knownUsageRequests, 2);
  assert.equal(summary.unknownUsageRequests, 2);
  assert.equal(summary.knownUsage.total, 420);
  assert.equal(summary.unknownUsageFields.cacheWrite, 1);
  assert.equal(summary.unknownUsageFields.reasoning, 1);
  assert.equal(summary.knownCostRequests, 1);
  assert.equal(summary.unknownCostRequests, 3);
  assert.deepEqual(summary.knownCost, { usd: { min: 0.1, max: 0.1 }, cny: { min: 0.7, max: 0.7 } });
});

test('default command is read-only status and worker bounds or conflicting modes are rejected', async (t) => {
  const options = await fixture(t);
  assert.deepEqual(parseProductionArguments([]), { mode: 'status', workers: 8 });
  assert.deepEqual(parseProductionArguments(['--execute', '--workers', '3']), { mode: 'execute', workers: 3 });
  assert.throws(() => parseProductionArguments(['--workers=9']), { code: 'INVALID_WORKERS' });
  assert.throws(() => parseProductionArguments(['--prepare', '--execute']), { code: 'INVALID_ARGUMENTS' });
  assert.equal((await readProductionStatus(options)).state, 'not-prepared');
  await assert.rejects(readFile(join(options.rootDir, 'generated/production/status.json')), { code: 'ENOENT' });
});
