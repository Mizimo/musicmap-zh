#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from './translate.mjs';
import { readProductionStatus, runChildProcess, signalActiveChildren, validateFrozenManifest } from './production.mjs';
import { queryFollowThroughService, queryTranslationService } from './follow-through.mjs';
import { assertLegacyTranslationAllowed } from '../lib/translation-retirement.mjs';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function validateOptions({ execute, shard, limit, retryFailed }) {
  if (typeof execute !== 'boolean' || typeof retryFailed !== 'boolean' ||
      (shard !== undefined && (!shard || shard.count !== 8 || !Number.isSafeInteger(shard.index) || shard.index < 1 || shard.index > 8)) ||
      (execute && shard === undefined) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) {
    fail('INVALID_ARGUMENTS', 'Execution requires --execute --shard N/8; --limit must be a nonnegative integer.');
  }
}

export function parseProductionShardArguments(args) {
  const options = { execute: false, retryFailed: false };
  const seen = new Set();
  for (let offset = 0; offset < args.length; offset += 1) {
    const argument = args[offset];
    if (seen.has(argument)) fail('INVALID_ARGUMENTS', 'Duplicate arguments are not accepted.');
    seen.add(argument);
    if (argument === '--execute') options.execute = true;
    else if (argument === '--retry-failed') options.retryFailed = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--shard') {
      const value = args[++offset];
      if (!/^[1-8]\/8$/.test(value ?? '')) fail('INVALID_ARGUMENTS', '--shard must be N/8, with N from 1 through 8.');
      options.shard = { index: Number(value[0]), count: 8 };
    } else if (argument === '--limit') {
      const value = args[++offset];
      if (!/^\d+$/.test(value ?? '')) fail('INVALID_ARGUMENTS', '--limit must be a nonnegative integer.');
      options.limit = Number(value);
    } else fail('INVALID_ARGUMENTS', 'Only --execute, --shard N/8, --limit N, --retry-failed and --help are accepted.');
  }
  validateOptions(options);
  return options;
}

/** One explicitly requested shard invocation. No retry loop or production-status writes. */
export async function runProductionShard({ rootDir = PROJECT_ROOT, execute = false, shard, limit, retryFailed = false,
  queryService = queryTranslationService, queryMonitor = queryFollowThroughService, runChild = runChildProcess,
  signal, manageSignals = true } = {}) {
  validateOptions({ execute, shard, limit, retryFailed });
  if (!execute) return { mode: 'read-only', production: await readProductionStatus({ rootDir }) };
  await assertLegacyTranslationAllowed(rootDir);
  const children = new Set();
  let stopping = false;
  const stop = () => { stopping = true; signalActiveChildren(children); };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop);
  if (manageSignals) { process.on('SIGTERM', stop); process.on('SIGINT', stop); }
  const preflight = async () => {
    for (const service of [await queryService(), await queryMonitor()]) {
      if (!['inactive', 'failed', 'missing'].includes(service.state) || service.pid !== 0) {
        fail('COORDINATOR_ACTIVE', 'The original production and follow-through services must both be stopped.');
      }
    }
    try { await lstat(join(rootDir, 'generated/production/lock')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    fail('PRODUCTION_LOCKED', 'A global production lock exists; it was not removed.');
  };
  try {
    if (stopping) return { mode: 'execution', code: 130, interrupted: true };
    await preflight();
    const manifest = JSON.parse(await readFile(join(rootDir, 'generated/production/manifest.json'), 'utf8'));
    await validateFrozenManifest(manifest, { rootDir });
    const env = { ...process.env, DEEPSEEK_API_KEY_FILE: manifest.authSourceFile,
      DEEPSEEK_BASE_URL: manifest.config.baseUrl, DEEPSEEK_MODEL: manifest.config.model,
      DEEPSEEK_REASONING_EFFORT: manifest.config.reasoningEffort,
      DEEPSEEK_MAX_TOKENS: String(manifest.config.maxTokens), DEEPSEEK_TIMEOUT_MS: String(manifest.config.timeoutMs) };
    delete env.DEEPSEEK_API_KEY;
    const args = ['--env-file-if-exists=.env', 'scripts/translate.mjs', '--language', 'zh-Hans',
      '--shard', `${shard.index}/8`, '--model', manifest.config.model, '--reasoning-effort', manifest.config.reasoningEffort];
    if (limit !== undefined) args.push('--limit', String(limit));
    if (retryFailed) args.push('--retry-failed');
    await preflight();
    if (stopping) return { mode: 'execution', code: 130, interrupted: true };
    const result = await runChild(process.execPath, args, { rootDir, env, kind: 'independent-shard', index: shard.index, activeChildren: children });
    return { mode: 'execution', shard, code: stopping ? 130 : result.code, interrupted: stopping };
  } finally {
    signal?.removeEventListener('abort', stop);
    if (manageSignals) { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseProductionShardArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/run-production-shard.mjs [--execute --shard N/8 [--limit N] [--retry-failed]]\nDefault is read-only production status. Explicit execution validates the frozen manifest and stopped coordinators, then runs the existing shard CLI once. No automatic retries or service starts.');
    else {
      const result = await runProductionShard(options);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.code ?? 0;
    }
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'PREFLIGHT_OR_EXECUTION_FAILED';
    console.error(`Independent shard stopped [${code}]. No automatic retry was made; inspect the existing shard journal and service state.`);
    process.exitCode = 1;
  }
}
