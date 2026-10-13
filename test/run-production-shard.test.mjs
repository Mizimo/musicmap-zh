import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FROZEN_FILES, prepareProduction } from '../scripts/production.mjs';
import { atomicJson } from '../scripts/translate.mjs';
import { parseProductionShardArguments, runProductionShard } from '../scripts/run-production-shard.mjs';

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-independent-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const file of FROZEN_FILES) {
    await mkdir(dirname(join(rootDir, file)), { recursive: true });
    await writeFile(join(rootDir, file), `fixture ${file}`);
  }
  await atomicJson(join(rootDir, '.cache/source/strings.json'), ['One', 'Two', 'Three']);
  await atomicJson(join(rootDir, 'data/terminology.json'), { version: 1, terms: [] });
  await atomicJson(join(rootDir, 'generated/locales/zh-Hans.json'), {});
  await prepareProduction({ rootDir, authSourceFile: join(rootDir, 'key-never-read') });
  return { rootDir, execute: true, shard: { index: 3, count: 8 }, manageSignals: false,
    queryService: async () => ({ state: 'failed', pid: 0 }), queryMonitor: async () => ({ state: 'inactive', pid: 0 }) };
}

test('default is read-only; execution requires a fixed shard and rejects configuration overrides', async (t) => {
  const options = await fixture(t);
  const before = await readFile(join(options.rootDir, 'generated/production/status.json'), 'utf8');
  let calls = 0;
  const result = await runProductionShard({ ...options, execute: false, runChild: async () => { calls += 1; } });
  assert.equal(result.mode, 'read-only');
  assert.equal(calls, 0);
  assert.equal(await readFile(join(options.rootDir, 'generated/production/status.json'), 'utf8'), before);
  assert.deepEqual(parseProductionShardArguments([]), { execute: false, retryFailed: false });
  for (const args of [['--execute'], ['--execute', '--shard', '2/7'], ['--model', 'other'], ['--limit', '-1'], ['--execute', '--execute']]) {
    assert.throws(() => parseProductionShardArguments(args), { code: 'INVALID_ARGUMENTS' });
  }
});

test('frozen mismatch, an active original coordinator, or global lock prevents every child launch', async (t) => {
  const options = await fixture(t);
  let calls = 0;
  options.runChild = async () => { calls += 1; return { code: 0 }; };
  await assert.rejects(runProductionShard({ ...options, queryService: async () => ({ state: 'active', pid: 42 }) }), { code: 'COORDINATOR_ACTIVE' });
  await assert.rejects(runProductionShard({ ...options, queryMonitor: async () => ({ state: 'activating', pid: 0 }) }), { code: 'COORDINATOR_ACTIVE' });
  await mkdir(join(options.rootDir, 'generated/production/lock'));
  await assert.rejects(runProductionShard(options), { code: 'PRODUCTION_LOCKED' });
  await rm(join(options.rootDir, 'generated/production/lock'), { recursive: true });
  await writeFile(join(options.rootDir, 'lib/translator.mjs'), 'changed');
  await assert.rejects(runProductionShard(options), { code: 'FROZEN_INPUT_CHANGED' });
  assert.equal(calls, 0);
});

test('one invocation pins manifest settings, allows other shard locks, retains retry/limit, and never rewrites production status', async (t) => {
  const options = await fixture(t);
  const before = await readFile(join(options.rootDir, 'generated/production/status.json'), 'utf8');
  await mkdir(join(options.rootDir, 'generated/translation-locks/zh-Hans-1-of-8'), { recursive: true });
  let calls = 0;
  const result = await runProductionShard({ ...options, limit: 10, retryFailed: true,
    runChild: async (command, args, child) => {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['--env-file-if-exists=.env', 'scripts/translate.mjs', '--language', 'zh-Hans', '--shard', '3/8', '--model', 'deepseek-v4-pro', '--reasoning-effort', 'max', '--limit', '10', '--retry-failed']);
      assert.equal(child.env.DEEPSEEK_API_KEY, undefined);
      assert.equal(child.env.DEEPSEEK_API_KEY_FILE, join(options.rootDir, 'key-never-read'));
      assert.equal(child.env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
      assert.equal(child.env.DEEPSEEK_MODEL, 'deepseek-v4-pro');
      assert.equal(child.env.DEEPSEEK_REASONING_EFFORT, 'max');
      assert.equal(child.env.DEEPSEEK_MAX_TOKENS, '32768');
      assert.equal(child.env.DEEPSEEK_TIMEOUT_MS, '600000');
      assert.equal(child.index, 3);
      return { code: 1 };
    } });
  assert.equal(calls, 1);
  assert.equal(result.code, 1);
  assert.equal(await readFile(join(options.rootDir, 'generated/production/status.json'), 'utf8'), before);
});

test('preflight rechecks coordinator state and stopping signals only the wrapper child', async (t) => {
  const options = await fixture(t);
  let queries = 0;
  await assert.rejects(runProductionShard({ ...options,
    queryService: async () => (++queries === 2 ? { state: 'active', pid: 42 } : { state: 'inactive', pid: 0 }),
    runChild: async () => assert.fail('must not spawn') }), { code: 'COORDINATOR_ACTIVE' });
  const controller = new AbortController();
  const signals = [];
  const result = await runProductionShard({ ...options, signal: controller.signal,
    runChild: async (_command, _args, { activeChildren }) => {
      const child = { exitCode: null, signalCode: null, killed: false, kill(value) { signals.push(value); this.killed = true; } };
      activeChildren.add(child);
      controller.abort();
      activeChildren.delete(child);
      return { code: 130 };
    } });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(result.code, 130);
  const interrupted = await runProductionShard({ ...options, signal: controller.signal, runChild: async () => assert.fail('must not spawn') });
  assert.equal(interrupted.code, 130);
});
