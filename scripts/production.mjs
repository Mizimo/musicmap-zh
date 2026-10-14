#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { atomicJson, loadSource, PROJECT_ROOT, shardForText, validateShardWrapper } from './translate.mjs';
import { assertLegacyTranslationAllowed } from '../lib/translation-retirement.mjs';

export const SHARD_COUNT = 8;
export const PRODUCTION_CONFIG = Object.freeze({
  language: 'zh-Hans', model: 'deepseek-v4-pro', reasoningEffort: 'max',
  baseUrl: 'https://api.deepseek.com', maxTokens: 32768, timeoutMs: 600000,
  batchMaxTexts: 20, batchMaxCharacters: 14000,
});
export const FROZEN_FILES = Object.freeze([
  '.cache/source/strings.json', 'data/terminology.json', 'public/dictionary.js',
  'generated/site/index.html', 'generated/site/master-genrelist.json', 'scripts/sync-source.mjs',
  'lib/terminology.mjs', 'lib/translator.mjs', 'lib/translation-context.mjs',
  'lib/translation-journal.mjs', 'lib/benchmark-cost.mjs', 'scripts/translate.mjs', 'scripts/production.mjs',
  'scripts/merge-translations.mjs', 'scripts/convert.mjs', 'scripts/build.mjs',
  'lib/chinese-conversion.mjs', 'test/browser.mjs',
  'benchmarks/pricing.json', 'package-lock.json',
]);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const productionDirectory = (rootDir) => join(rootDir, 'generated/production');
const shardFile = (index) => `generated/shards/zh-Hans-${index}-of-${SHARD_COUNT}.json`;
const now = () => new Date().toISOString();

export class ProductionError extends Error {
  constructor(code, message) { super(message); this.name = 'ProductionError'; this.code = code; }
}
const fail = (code, message) => { throw new ProductionError(code, message); };

async function readJson(file, { optional = false } = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail('INVALID_FILE', `Cannot read a valid JSON object from ${file}.`);
  }
}

async function currentFrozenInputs(rootDir) {
  const { sourceHash, source } = await loadSource(rootDir);
  const files = {};
  for (const file of FROZEN_FILES) {
    try { files[file] = digest(await readFile(join(rootDir, file))); }
    catch { fail('FROZEN_INPUT_MISSING', `Required frozen input is missing or unreadable: ${file}.`); }
  }
  const terminology = await readJson(join(rootDir, 'data/terminology.json'));
  return {
    source, frozen: {
      sourceHash, terminologyHash: digest(JSON.stringify(terminology)),
      terminologyVersion: terminology.version, files,
    },
  };
}

export async function validateFrozenManifest(manifest, { rootDir = PROJECT_ROOT } = {}) {
  if (manifest?.schemaVersion !== 1 || manifest.shardCount !== SHARD_COUNT ||
      JSON.stringify(manifest.config) !== JSON.stringify(PRODUCTION_CONFIG) ||
      typeof manifest.authSourceFile !== 'string' || !manifest.authSourceFile.startsWith('/')) {
    fail('MANIFEST_MISMATCH', 'The production manifest does not match the fixed eight-shard Pro / Max configuration.');
  }
  const current = await currentFrozenInputs(rootDir);
  if (JSON.stringify(manifest.frozen) !== JSON.stringify(current.frozen)) {
    fail('FROZEN_INPUT_CHANGED', 'A frozen source, terminology, prompt, translation program, dependency, or pricing file changed. No workers were started.');
  }
  if (!Array.isArray(manifest.shards) || manifest.shards.length !== SHARD_COUNT ||
      manifest.shards.some((shard, offset) => shard.index !== offset + 1 || shard.file !== shardFile(offset + 1) ||
        shard.total !== current.source.filter((text) => shardForText(text, SHARD_COUNT) === shard.index).length)) {
    fail('MANIFEST_MISMATCH', 'The production manifest contains invalid shard assignments.');
  }
  return current;
}

export async function acquireProductionLock(rootDir = PROJECT_ROOT) {
  const directory = productionDirectory(rootDir);
  const lock = join(directory, 'lock');
  await mkdir(directory, { recursive: true });
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') fail('PRODUCTION_LOCKED', 'A production lock exists. Confirm the recorded process and all shard workers have stopped before manually removing a stale lock.');
    throw error;
  }
  try { await atomicJson(join(lock, 'owner.json'), { pid: process.pid, machine: hostname(), acquiredAt: now() }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  let released = false;
  return async () => {
    if (!released) { await rm(lock, { recursive: true }); released = true; }
  };
}

async function readSeedTranslations(rootDir, source) {
  const locale = await readJson(join(rootDir, 'generated/locales/zh-Hans.json'), { optional: true }) ?? {};
  if (typeof locale !== 'object' || Array.isArray(locale)) fail('INVALID_SEED', 'The existing Simplified Chinese locale must be an object.');
  const known = new Set(source);
  for (const [text, translated] of Object.entries(locale)) {
    if (!known.has(text) || typeof translated !== 'string' || !translated.trim()) {
      fail('INVALID_SEED', 'The existing Simplified Chinese locale contains an unknown source or invalid translation. No seed entries were discarded.');
    }
  }
  return locale;
}

async function readShardWrapper(rootDir, index, sourceHash, source, { optional = false } = {}) {
  const file = shardFile(index);
  const wrapper = await readJson(join(rootDir, file), { optional });
  if (!wrapper) return null;
  try {
    validateShardWrapper(wrapper, { sourceHash, source, language: 'zh-Hans', shard: { index, count: SHARD_COUNT } });
  } catch { fail('SHARD_MISMATCH', `The existing shard ${index}/${SHARD_COUNT} has incompatible metadata or translations. It was not changed.`); }
  return wrapper;
}

async function verifyShardDirectory(rootDir) {
  const allowed = new Set(Array.from({ length: SHARD_COUNT }, (_, offset) => `zh-Hans-${offset + 1}-of-${SHARD_COUNT}.json`));
  let entries;
  try { entries = await readdir(join(rootDir, 'generated/shards'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entries.some((entry) => entry.isDirectory() || (entry.name.endsWith('.json') && !allowed.has(entry.name)))) {
    fail('SHARD_DIRECTORY_MISMATCH', 'The shard directory contains additional partitions or nested shard data. Resolve the partition layout before preparing or executing production.');
  }
}

export async function prepareProduction({
  rootDir = PROJECT_ROOT, machine = hostname(), authSourceFile = join(homedir(), '.ssh/musicmap_trans'),
} = {}) {
  await assertLegacyTranslationAllowed(rootDir);
  const release = await acquireProductionLock(rootDir);
  try {
    const manifestFile = join(productionDirectory(rootDir), 'manifest.json');
    const existing = await readJson(manifestFile, { optional: true });
    const { source, frozen } = existing
      ? await validateFrozenManifest(existing, { rootDir }) : await currentFrozenInputs(rootDir);
    if (existing && existing.authSourceFile !== resolve(authSourceFile)) {
      fail('AUTH_SOURCE_CHANGED', 'The requested credential file differs from the frozen production manifest.');
    }
    await verifyShardDirectory(rootDir);
    const seed = await readSeedTranslations(rootDir, source);
    const plans = [];
    // Validate every prior shard and every overlap before writing even the first seed.
    for (let index = 1; index <= SHARD_COUNT; index += 1) {
      const original = await readShardWrapper(rootDir, index, frozen.sourceHash, source, { optional: !existing });
      const translations = Object.assign(Object.create(null), original?.translations);
      const assigned = source.filter((text) => shardForText(text, SHARD_COUNT) === index);
      for (const text of assigned) if (Object.hasOwn(seed, text)) {
        if (Object.hasOwn(translations, text) && translations[text] !== seed[text]) {
          fail('SEED_CONFLICT', `Existing locale and shard ${index}/${SHARD_COUNT} disagree. No translations were overwritten.`);
        }
        translations[text] = seed[text];
      }
      plans.push({ index, assigned, original, wrapper: {
        ...original, sourceHash: frozen.sourceHash, language: 'zh-Hans',
        shard: { index, count: SHARD_COUNT }, translations,
      } });
    }
    if (existing) return readProductionStatus({ rootDir });
    for (const plan of plans) {
      if (JSON.stringify(plan.original) !== JSON.stringify(plan.wrapper)) {
        await atomicJson(join(rootDir, shardFile(plan.index)), plan.wrapper);
      }
    }
    let gitCommit = null;
    try { gitCommit = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: rootDir })).stdout.trim(); } catch { /* Temporary fixtures and source archives need not have Git metadata. */ }
    const manifest = {
      schemaVersion: 1, createdAt: now(), machine, gitCommit,
      authSourceFile: resolve(authSourceFile), config: { ...PRODUCTION_CONFIG },
      shardCount: SHARD_COUNT, total: source.length, frozen,
      initialSeed: { count: Object.keys(seed).length, hash: digest(JSON.stringify(seed)) },
      shards: plans.map((plan) => ({
        index: plan.index, count: SHARD_COUNT, file: shardFile(plan.index),
        total: plan.assigned.length, initialAvailable: Object.keys(plan.wrapper.translations).length,
      })),
    };
    await atomicJson(manifestFile, manifest);
    const status = await readProductionStatus({ rootDir });
    await atomicJson(join(productionDirectory(rootDir), 'status.json'), status);
    return status;
  } finally { await release(); }
}

export async function readProductionStatus({ rootDir = PROJECT_ROOT } = {}) {
  const directory = productionDirectory(rootDir);
  const manifest = await readJson(join(directory, 'manifest.json'), { optional: true });
  if (!manifest) return { state: 'not-prepared', inspectedAt: now(), message: 'Run --prepare to freeze inputs and seed eight shards. No API calls were made.' };
  const { sourceHash, source } = await loadSource(rootDir);
  if (sourceHash !== manifest.frozen?.sourceHash) fail('SOURCE_CHANGED', 'Current source does not match the production manifest; progress cannot be compared safely.');
  const recorded = await readJson(join(directory, 'status.json'), { optional: true });
  const shards = [];
  for (const shard of manifest.shards) {
    const wrapper = await readShardWrapper(rootDir, shard.index, sourceHash, source);
    const state = await readJson(join(directory, 'shards', `${shard.index}.json`), { optional: true });
    const translated = Object.keys(wrapper.translations).length;
    shards.push({ ...state, index: shard.index, file: shard.file, translated, total: shard.total,
      complete: translated === shard.total,
      state: translated === shard.total ? 'translated' : state?.state ?? 'pending',
    });
  }
  const translated = shards.reduce((sum, shard) => sum + shard.translated, 0);
  return {
    ...recorded, state: recorded?.state ?? 'prepared', inspectedAt: now(),
    model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort,
    sourceHash, translated, total: source.length, translationComplete: translated === source.length,
    shards, requests: await summarizeRequestJournals(rootDir, sourceHash),
  };
}

export async function summarizeRequestJournals(rootDir, sourceHash) {
  const summary = {
    total: 0, completed: 0, failed: 0, pending: 0, excludedSourceMismatch: 0,
    knownUsageRequests: 0, unknownUsageRequests: 0,
    knownUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
    unknownUsageFields: {}, knownCostRequests: 0, unknownCostRequests: 0,
    knownCost: { usd: { min: 0, max: 0 }, cny: { min: 0, max: 0 } },
  };
  async function jsonFiles(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await jsonFiles(join(directory, entry.name)));
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(join(directory, entry.name));
    }
    return files;
  }
  const seen = new Set();
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    const files = await jsonFiles(join(rootDir, 'generated/translation-requests', `zh-Hans-${index}-of-${SHARD_COUNT}`));
    for (const file of files) {
      const record = await readJson(file);
      if (record.identity?.sourceHash !== sourceHash) { summary.excludedSourceMismatch += 1; continue; }
      if (typeof record.requestId !== 'string' || seen.has(record.requestId) || !['started', 'completed', 'failed'].includes(record.type)) {
        fail('INVALID_JOURNAL', 'Production request records contain an invalid state or duplicate request identifier.');
      }
      seen.add(record.requestId);
      summary.total += 1;
      summary[record.type === 'started' ? 'pending' : record.type] += 1;
      if (record.normalizedUsage && Number.isFinite(record.normalizedUsage.input) && Number.isFinite(record.normalizedUsage.output)) {
        summary.knownUsageRequests += 1;
        for (const field of Object.keys(summary.knownUsage)) {
          const value = record.normalizedUsage[field];
          if (Number.isFinite(value) && value >= 0) summary.knownUsage[field] += value;
          else summary.unknownUsageFields[field] = (summary.unknownUsageFields[field] ?? 0) + 1;
        }
      } else summary.unknownUsageRequests += 1;
      if (['usd', 'cny'].every((currency) => ['min', 'max'].every((bound) => Number.isFinite(record.cost?.[currency]?.[bound])))) {
        summary.knownCostRequests += 1;
        for (const currency of ['usd', 'cny']) for (const bound of ['min', 'max']) summary.knownCost[currency][bound] += record.cost[currency][bound];
      } else summary.unknownCostRequests += 1;
    }
  }
  return summary;
}

export async function runWorkerPool(items, { workers = SHARD_COUNT, run, onResult = async () => {}, shouldStop = () => false } = {}) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > SHARD_COUNT) fail('INVALID_WORKERS', '--workers must be an integer from 1 through 8.');
  let next = 0;
  let failed = false;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (!failed && !shouldStop() && next < items.length) {
      const item = items[next++];
      let result;
      try { result = await run(item, { shouldStop: () => failed || shouldStop() }); }
      catch (error) { result = { code: 1, errorCode: error instanceof ProductionError ? error.code : 'WORKER_FAILED' }; }
      if (result?.code !== 0) failed = true;
      const entry = { item, result };
      results.push(entry);
      try { await onResult(entry); }
      catch { failed = true; entry.result = { code: 1, errorCode: 'STATUS_WRITE_FAILED' }; }
    }
  }));
  return { failed, stopped: shouldStop(), results, unstarted: items.slice(next) };
}

export function runChildProcess(command, args, options) {
  return new Promise((resolveChild) => {
    const child = (options.spawnImpl ?? spawn)(command, args, { cwd: options.rootDir, env: options.env, stdio: 'inherit' });
    options.activeChildren?.add(child);
    const finish = (result) => { options.activeChildren?.delete(child); resolveChild(result); };
    child.once('error', () => finish({ code: 1, errorCode: 'PROCESS_START_FAILED' }));
    child.once('exit', (code, signal) => finish({ code: code ?? 1, ...(signal ? { signal } : {}) }));
  });
}

export function signalActiveChildren(children) {
  let signaled = 0;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) continue;
    try { if (child.kill('SIGTERM')) signaled += 1; }
    catch { /* The tracked child may already have exited between checking and signalling. */ }
  }
  return signaled;
}

export async function executeProduction({
  rootDir = PROJECT_ROOT, workers = SHARD_COUNT, runChild = runChildProcess,
  manageSignals = true, log = console.log,
} = {}) {
  await assertLegacyTranslationAllowed(rootDir);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > SHARD_COUNT) fail('INVALID_WORKERS', '--workers must be an integer from 1 through 8.');
  const release = await acquireProductionLock(rootDir);
  const directory = productionDirectory(rootDir);
  let stopping = false;
  let workerFailed = false;
  let executionStarted = false;
  let persisted = Promise.resolve();
  const activeChildren = new Set();
  const requestStop = () => {
    stopping = true;
    signalActiveChildren(activeChildren);
    log('Stop requested. Active translation workers will preserve their current batch and then exit; no new workers will start.');
  };
  if (manageSignals) { process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop); }
  try {
    const manifest = await readJson(join(directory, 'manifest.json'));
    const { source, frozen } = await validateFrozenManifest(manifest, { rootDir });
    await verifyShardDirectory(rootDir);
    let status = await readProductionStatus({ rootDir });
    if (status.state === 'completed' && status.translationComplete) {
      log('Production was already completed; no workers or build commands were repeated.');
      return status;
    }
    const seed = await readSeedTranslations(rootDir, source);
    for (const shard of manifest.shards) {
      const wrapper = await readShardWrapper(rootDir, shard.index, frozen.sourceHash, source);
      for (const [text, translated] of Object.entries(wrapper.translations)) {
        if (Object.hasOwn(seed, text) && seed[text] !== translated) fail('SEED_CONFLICT', 'Existing locale and shard translations conflict. No workers were started.');
      }
    }
    const environment = {
      ...process.env, DEEPSEEK_API_KEY_FILE: manifest.authSourceFile,
      DEEPSEEK_BASE_URL: manifest.config.baseUrl, DEEPSEEK_MODEL: manifest.config.model,
      DEEPSEEK_REASONING_EFFORT: manifest.config.reasoningEffort,
      DEEPSEEK_MAX_TOKENS: String(manifest.config.maxTokens), DEEPSEEK_TIMEOUT_MS: String(manifest.config.timeoutMs),
    };
    delete environment.DEEPSEEK_API_KEY;
    const startedAt = now();
    const saveStatus = (patch = {}) => {
      persisted = persisted.then(async () => {
        status = { ...await readProductionStatus({ rootDir }), ...patch, updatedAt: now() };
        await atomicJson(join(directory, 'status.json'), status);
      });
      return persisted;
    };
    await saveStatus({ state: 'running', startedAt, finishedAt: null, workers, pid: process.pid, machine: hostname(), errorCode: null });
    executionStarted = true;
    const pending = status.shards.filter((shard) => !shard.complete).map((shard) => shard.index);
    const pool = await runWorkerPool(pending, {
      workers, shouldStop: () => stopping || workerFailed,
      run: async (index, control) => {
        await atomicJson(join(directory, 'shards', `${index}.json`), { state: 'running', startedAt: now(), index });
        await saveStatus();
        if (control.shouldStop()) return { code: 1, errorCode: 'CANCELLED_BEFORE_START' };
        log(`Starting Simplified Chinese shard ${index}/${SHARD_COUNT} with ${manifest.config.model} / ${manifest.config.reasoningEffort}.`);
        const result = await runChild(process.execPath, [
          '--env-file-if-exists=.env', 'scripts/translate.mjs', '--language', 'zh-Hans',
          '--shard', `${index}/${SHARD_COUNT}`, '--model', manifest.config.model,
          '--reasoning-effort', manifest.config.reasoningEffort,
        ], { rootDir, env: environment, kind: 'translation', index, activeChildren });
        if (result.code !== 0) return result;
        const wrapper = await readShardWrapper(rootDir, index, frozen.sourceHash, source);
        if (Object.keys(wrapper.translations).length !== manifest.shards[index - 1].total) return { code: 1, errorCode: 'SHARD_INCOMPLETE' };
        return result;
      },
      onResult: async ({ item: index, result }) => {
        if (result.code !== 0 && !workerFailed) {
          workerFailed = true;
          signalActiveChildren(activeChildren);
        }
        const previous = await readJson(join(directory, 'shards', `${index}.json`));
        await atomicJson(join(directory, 'shards', `${index}.json`), {
          ...previous, state: result.code === 0 ? 'translated' : 'failed', finishedAt: now(),
          exitCode: result.code, ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.signal ? { signal: result.signal } : {}),
        });
        await saveStatus();
      },
    });
    if (pool.failed || stopping) {
      await saveStatus({ state: stopping ? 'interrupted' : 'failed', finishedAt: now(), errorCode: pool.failed ? 'SHARD_FAILED' : 'STOP_REQUESTED', unstartedShards: pool.unstarted });
      log('Production stopped with partial progress preserved. Failed or unresolved requests require review; no automatic retry was made.');
      return status;
    }
    await saveStatus({ state: 'finalizing', finalization: [] });
    if (!status.translationComplete) fail('INCOMPLETE_TRANSLATION', 'All workers exited, but Simplified Chinese coverage is incomplete.');
    for (const script of ['merge', 'convert', 'build', 'test:browser']) {
      if (stopping) { await saveStatus({ state: 'interrupted', finishedAt: now(), errorCode: 'STOP_REQUESTED' }); return status; }
      log(`Running final verification: npm run ${script}.`);
      const result = await runChild('npm', ['run', script], { rootDir, env: environment, kind: 'finalization', script, activeChildren });
      const finalization = [...status.finalization, { script, exitCode: result.code, finishedAt: now() }];
      await saveStatus({ finalization });
      if (result.code !== 0) {
        await saveStatus({ state: 'failed', finishedAt: now(), errorCode: 'FINALIZATION_FAILED' });
        return status;
      }
    }
    await saveStatus({ state: 'completed', finishedAt: now(), errorCode: null, unstartedShards: [] });
    log('COMPLETE: all eight Simplified Chinese shards, local Traditional Chinese conversion, strict build, and browser verification passed.');
    return status;
  } catch (error) {
    if (executionStarted) {
      try {
        await persisted.catch(() => {});
        const current = await readProductionStatus({ rootDir });
        await atomicJson(join(directory, 'status.json'), {
          ...current, state: 'failed', finishedAt: now(),
          errorCode: error instanceof ProductionError ? error.code : 'PRODUCTION_FAILED',
        });
      } catch { /* Preserve the initial failure when even status persistence is unavailable. */ }
    }
    throw error;
  } finally {
    await persisted.catch(() => {});
    if (manageSignals) { process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop); }
    await release();
  }
}

export function parseProductionArguments(args) {
  const options = { mode: 'status', workers: SHARD_COUNT };
  let explicitMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--chapter-pilot') options.chapterPilot = true;
    else if (['--status', '--prepare', '--execute', '--report'].includes(argument)) {
      if (explicitMode) fail('INVALID_ARGUMENTS', 'Choose exactly one of --status, --prepare, or --execute.');
      options.mode = argument.slice(2); explicitMode = true;
    } else if (argument === '--workers' || argument.startsWith('--workers=')) {
      const value = argument.includes('=') ? argument.slice('--workers='.length) : args[++index];
      if (!/^[1-8]$/.test(value ?? '')) fail('INVALID_WORKERS', '--workers must be an integer from 1 through 8.');
      options.workers = Number(value);
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('INVALID_ARGUMENTS', 'Unsupported production argument. See --help.');
  }
  if (options.mode === 'report' && !options.chapterPilot) fail('INVALID_ARGUMENTS', '--report requires --chapter-pilot.');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseProductionArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/production.mjs --chapter-pilot [--status | --prepare | --execute | --report]\n\nThe whole-chapter pilot preserves eight source-hash shards and uses one global ten-attempt budget.\n--prepare freezes full chapter inputs without an API call. --execute sends at most ten sequential Pro Max requests, including failed attempts, with no retries.\n--report creates comparison artifacts and an isolated partial build without publishing or adopting the trial.\nDefault --status is read-only. Legacy production has been retired in this workspace.');
    } else if (options.chapterPilot) {
      const { chapterPilotCommand } = await import('../lib/chapter-pilot.mjs');
      const result = await chapterPilotCommand(options.mode);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = options.mode === 'prepare' ? await prepareProduction()
        : options.mode === 'execute' ? await executeProduction({ workers: options.workers }) : await readProductionStatus();
      console.log(JSON.stringify(result, null, 2));
      if (options.mode === 'execute' && result.state !== 'completed') process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof ProductionError || error.code?.startsWith('PILOT_') || ['TRANSLATION_RETIRED','UNRESOLVED_ATTEMPT'].includes(error.code)
      ? `Production stopped [${error.code}]: ${error.message}`
      : 'Production stopped: an internal file or process operation failed. Existing progress was preserved.');
    process.exitCode = 1;
  }
}
