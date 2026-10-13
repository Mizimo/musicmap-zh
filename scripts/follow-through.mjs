#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeUsage } from '../lib/benchmark-cost.mjs';
import { loadTranslationContexts } from '../lib/translation-context.mjs';
import { TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { TRANSLATION_PROMPT_TEMPLATE_HASH } from '../lib/translator.mjs';
import { atomicJson, makeBatches, PROJECT_ROOT, shardForText, validateShardWrapper } from './translate.mjs';
import { acquireProductionLock, readProductionStatus, runChildProcess, runWorkerPool, signalActiveChildren, validateFrozenManifest } from './production.mjs';

export const RECOVERY_POLICY = Object.freeze({ maxRequests: 20, maxWorkers: 2, maxRetriesPerBatch: 1, pollMs: 30000, unit: 'musicmap-translation.service' });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const base = (rootDir) => join(rootDir, 'generated/production');
const ledgerPath = (rootDir) => join(base(rootDir), 'follow-through.json');
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class RecoveryReviewRequired extends Error {
  constructor(code, message) { super(message); this.name = 'RecoveryReviewRequired'; this.code = code; }
}
const review = (code, message) => { throw new RecoveryReviewRequired(code, message); };
async function json(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; review('INVALID_FILE', 'A required production or recovery JSON record is missing or invalid.'); }
}

export async function acquireFollowThroughLock(rootDir) {
  const lock = join(base(rootDir), 'follow-through-lock');
  await mkdir(base(rootDir), { recursive: true });
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') review('SUPERVISOR_LOCKED', 'A follow-through lock exists. Verify its recorded process before manually handling a stale lock.'); throw error; }
  try { await atomicJson(join(lock, 'owner.json'), { pid: process.pid, machine: hostname(), startedAt: now() }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  return () => rm(lock, { recursive: true });
}

export async function queryTranslationService() {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('systemctl', ['--user', 'show', RECOVERY_POLICY.unit, '--property=LoadState,ActiveState,SubState,MainPID'], { timeout: 10000, maxBuffer: 16384 }));
  } catch (error) {
    // A successful transient service may already have been unloaded by systemd.
    if (typeof error.stdout === 'string' && error.stdout.includes('LoadState=not-found')) stdout = error.stdout;
    else review('SERVICE_QUERY_FAILED', 'The translation service state could not be verified.');
  }
  const fields = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('=')));
  if (fields.LoadState === 'not-found' && fields.ActiveState === 'inactive' && Number(fields.MainPID) === 0) return { state: 'missing', substate: fields.SubState, pid: 0 };
  if (fields.LoadState !== 'loaded' || !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(fields.ActiveState)) review('SERVICE_STATE_UNKNOWN', 'The existing translation service is missing or has an unsupported state.');
  return { state: fields.ActiveState, substate: fields.SubState, pid: Number(fields.MainPID) };
}

export async function startTranslationService() {
  // `start` resumes a failed/inactive unit and is a no-op if another operator already started it.
  try { await promisify(execFile)('systemctl', ['--user', 'start', RECOVERY_POLICY.unit], { timeout: 10000, maxBuffer: 16384 }); }
  catch { review('SERVICE_START_FAILED', 'The existing translation service could not be resumed.'); }
}

async function requireNoShardLocks(rootDir) {
  let entries;
  try { entries = await readdir(join(rootDir, 'generated/translation-locks')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entries.length) review('SHARD_LOCKED', 'Shard locks remain. No retry was started and no stale lock was removed.');
}

export async function readRecoveryRecords(rootDir) {
  const groups = {};
  const ids = new Set();
  for (let index = 1; index <= 8; index += 1) {
    const directory = join(rootDir, `generated/translation-requests/zh-Hans-${index}-of-8`);
    let files;
    try { files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    groups[index] = [];
    for (const file of files) {
      const record = await json(join(directory, file));
      if (typeof record.requestId !== 'string' || file !== `${record.requestId}.json` || ids.has(record.requestId)) review('JOURNAL_TAMPERED', 'Request filenames or identifiers are inconsistent.');
      ids.add(record.requestId);
      groups[index].push(record);
    }
  }
  return groups;
}

export function unresolvedRecords(records) {
  const indexed = new Map(records.map((record) => [record.requestId, record]));
  const reviewed = new Set();
  for (const record of records) {
    if (!['started', 'completed', 'failed'].includes(record.type) || !Array.isArray(record.reviewedPreviousRequestIds ?? [])) review('JOURNAL_TAMPERED', 'A request record has an invalid review state.');
    for (const previousId of record.reviewedPreviousRequestIds ?? []) {
      const previous = indexed.get(previousId);
      if (!previous || previousId === record.requestId || !['failed', 'started'].includes(previous.type) || previous.identityHash !== record.identityHash) {
        review('JOURNAL_TAMPERED', 'A prior-request review does not refer to a real failed request with the same frozen configuration.');
      }
      reviewed.add(previousId);
    }
  }
  return records.filter((record) => ['failed', 'started'].includes(record.type) && !reviewed.has(record.requestId));
}

function validateLedger(ledger, manifest) {
  if (!ledger || ledger.schemaVersion !== 1 || !same(ledger.policy, RECOVERY_POLICY) || ledger.manifestHash !== hash(JSON.stringify(manifest)) ||
      !['monitoring', 'recovering', 'restarting', 'completed', 'interrupted', 'needs-review'].includes(ledger.state) ||
      !Array.isArray(ledger.attempts) || ledger.attempts.length > RECOVERY_POLICY.maxRequests || ledger.reservedRequests !== ledger.attempts.length) {
    review('LEDGER_MISMATCH', 'The durable recovery ledger or its frozen policy has changed.');
  }
  const batches = new Set();
  for (const entry of ledger.attempts) {
    if (!entry || !validHash(entry.batchKey) || batches.has(entry.batchKey) || !validHash(entry.failedRecordHash) ||
        !Number.isSafeInteger(entry.index) || entry.index < 1 || entry.index > 8 || typeof entry.failedRequestId !== 'string' ||
        !['reserved', 'completed', 'needs-review', 'interrupted'].includes(entry.state)) review('LEDGER_MISMATCH', 'Recovery reservations are duplicated or invalid.');
    batches.add(entry.batchKey);
  }
}

function hasKnownUsage(record) {
  const usage = normalizeUsage('deepseek', record.rawUsage);
  const raw = record.rawUsage;
  return usage && same(usage, record.normalizedUsage) && Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0) &&
    ['total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].every((field) => Number.isSafeInteger(raw?.[field]) && raw[field] >= 0) &&
    raw.total_tokens === usage.input + usage.output && raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens === usage.input &&
    usage.input + usage.output === usage.total && usage.reasoning <= usage.output && usage.cacheRead + usage.cacheWrite <= usage.input;
}

/** Pure policy gate: select only one known-cost schema-failure retry for the unchanged first missing batch. */
export function planRecovery({ recordsByShard, manifest, source, shards, identity, contexts, ledger }) {
  validateLedger(ledger, manifest);
  if (ledger.state === 'needs-review' || ledger.attempts.some((attempt) => attempt.state !== 'completed')) review('PRIOR_RETRY_UNRESOLVED', 'A prior recovery attempt was interrupted or needs review; its reserved request budget is retained.');
  if (ledger.reservedRequests >= RECOVERY_POLICY.maxRequests) review('RECOVERY_CAP', 'The persistent twenty-request recovery cap has been reached.');
  const expectedIdentityHash = hash(JSON.stringify(identity));
  const candidates = [];
  for (let index = 1; index <= 8; index += 1) {
    const records = recordsByShard[index] ?? [];
    for (const attempt of ledger.attempts.filter((item) => item.index === index)) {
      const original = records.find((record) => record.requestId === attempt.failedRequestId);
      if (!original || hash(JSON.stringify(original)) !== attempt.failedRecordHash) review('JOURNAL_TAMPERED', 'An already reviewed failed request changed or disappeared.');
      const completed = records.find((record) => record.requestId === attempt.completedRequestId);
      if (attempt.state === 'completed' && (!completed || hash(JSON.stringify(completed)) !== attempt.completedRecordHash)) review('JOURNAL_TAMPERED', 'A recorded successful bounded retry changed or disappeared.');
    }
    const unresolved = unresolvedRecords(records);
    if (unresolved.length > 1) review('MULTIPLE_UNRESOLVED', 'A shard has more than one unresolved request.');
    if (!unresolved.length) continue;
    const record = unresolved[0];
    if (record.type !== 'failed' || record.httpStatus !== 200 || record.finishReason !== 'stop' || record.errorCode !== 'INVALID_TRANSLATION') {
      review('UNREVIEWABLE_FAILURE', 'Only a completed HTTP 200 / stop response rejected by translation schema may receive a bounded retry.');
    }
    if (!hasKnownUsage(record)) {
      review('UNKNOWN_USAGE', 'The failed request has missing or inconsistent token accounting.');
    }
    if (!same(record.identity, identity) || record.identityHash !== expectedIdentityHash ||
        record.model !== manifest.config.model || record.reasoningEffort !== manifest.config.reasoningEffort ||
        record.maxTokens !== manifest.config.maxTokens || record.timeoutMs !== manifest.config.timeoutMs ||
        (record.returnedModel !== null && record.returnedModel !== manifest.config.model) ||
        (record.returnedEffort !== null && record.returnedEffort !== manifest.config.reasoningEffort) || record.language !== 'zh-Hans') {
      review('CONFIGURATION_MISMATCH', 'The failed request does not match the current frozen translation configuration.');
    }
    const count = record.sourceCount;
    if (!Number.isSafeInteger(count) || count < 1 || count > 20 || !Array.isArray(record.textHashes) || record.textHashes.length !== count || record.textHashes.some((value) => !validHash(value))) {
      review('INVALID_BATCH', 'The failed request has an invalid exact-batch declaration.');
    }
    const wrapper = shards[index];
    try { validateShardWrapper(wrapper, { sourceHash: manifest.frozen.sourceHash, source, language: 'zh-Hans', shard: { index, count: 8 } }); }
    catch { review('SHARD_MISMATCH', 'A shard no longer matches its frozen source assignment.'); }
    const missing = source.filter((text) => shardForText(text, 8) === index && !Object.hasOwn(wrapper.translations, text));
    const texts = missing.slice(0, count);
    if (texts.length !== count || !same(texts.map(hash), record.textHashes) || hash(JSON.stringify(texts)) !== record.sourceHash ||
        makeBatches(texts).length !== 1 || !same(texts.map((text) => hash(contexts.get(text) ?? '')), record.contextHashes)) {
      review('BATCH_CHANGED', 'The first missing source fragments or their context differ from the failed batch.');
    }
    if (records.some((other) => other.type === 'completed' && other.identityHash === expectedIdentityHash && other.textHashes?.some((value) => record.textHashes.includes(value)))) {
      review('ALREADY_PAID_OUTPUT', 'Completed journal output overlaps the retry batch; recover it without purchasing it again.');
    }
    const historical = records.filter((other) => other.type === 'failed' && other.identityHash === record.identityHash && other.sourceHash === record.sourceHash);
    const batchKey = hash(`${record.identityHash}:${record.sourceHash}`);
    if (historical.length !== 1 || ledger.attempts.some((attempt) => attempt.batchKey === batchKey)) review('RETRY_EXHAUSTED', 'This exact batch already used its single retry or failed more than once.');
    candidates.push({ index, failedRequestId: record.requestId, failedRecordHash: hash(JSON.stringify(record)),
      identityHash: record.identityHash, sourceHash: record.sourceHash, textHashes: record.textHashes,
      sourceCount: count, batchKey, priorRequestIds: records.map((item) => item.requestId) });
  }
  if (!candidates.length) review('NO_ELIGIBLE_FAILURE', 'The service stopped without an eligible unresolved schema failure.');
  if (ledger.reservedRequests + candidates.length > RECOVERY_POLICY.maxRequests) review('RECOVERY_CAP', 'The persistent twenty-request recovery cap would be exceeded.');
  return candidates;
}

async function recoveryInputs(rootDir, manifest) {
  const { source } = await validateFrozenManifest(manifest, { rootDir });
  const contexts = await loadTranslationContexts({ rootDir, source });
  const identity = {
    sourceHash: manifest.frozen.sourceHash, model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort,
    maxTokens: manifest.config.maxTokens, baseUrl: manifest.config.baseUrl,
    promptTemplateHash: TRANSLATION_PROMPT_TEMPLATE_HASH, terminologyHash: TERMINOLOGY_HASH,
    contextsHash: hash(JSON.stringify([...contexts])),
  };
  const shards = {};
  for (let index = 1; index <= 8; index += 1) shards[index] = await json(join(rootDir, `generated/shards/zh-Hans-${index}-of-8.json`));
  return { recordsByShard: await readRecoveryRecords(rootDir), manifest, source, shards, identity, contexts };
}

export async function readFollowThroughStatus({ rootDir = PROJECT_ROOT } = {}) {
  return { recovery: await json(ledgerPath(rootDir), true) ?? { state: 'not-started', reservedRequests: 0, policy: RECOVERY_POLICY }, production: await readProductionStatus({ rootDir }) };
}

export async function runFollowThrough({ rootDir = PROJECT_ROOT, queryService = queryTranslationService,
  resumeService = startTranslationService, runChild = runChildProcess,
  sleep = (signal) => delay(RECOVERY_POLICY.pollMs, undefined, { signal }), signal,
  manageSignals = true, log = console.log } = {}) {
  const release = await acquireFollowThroughLock(rootDir);
  const controller = new AbortController();
  const activeChildren = new Set();
  let ledger;
  let writes = Promise.resolve();
  const stop = () => { controller.abort(); signalActiveChildren(activeChildren); };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop);
  if (manageSignals) { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  const persist = () => {
    writes = writes.then(() => atomicJson(ledgerPath(rootDir), { ...ledger, updatedAt: now() }));
    return writes;
  };
  try {
    const manifest = await json(join(base(rootDir), 'manifest.json'));
    await validateFrozenManifest(manifest, { rootDir });
    ledger = await json(ledgerPath(rootDir), true);
    if (!ledger) {
      ledger = { schemaVersion: 1, createdAt: now(), state: 'monitoring', manifestHash: hash(JSON.stringify(manifest)), policy: { ...RECOVERY_POLICY }, reservedRequests: 0, attempts: [], restarts: [] };
      await persist();
    }
    validateLedger(ledger, manifest);
    if (ledger.state === 'needs-review' || ledger.attempts.some((attempt) => attempt.state !== 'completed')) review('PRIOR_RETRY_UNRESOLVED', 'A previous bounded retry remains unresolved. No new paid request was started.');
    while (!controller.signal.aborted) {
      await validateFrozenManifest(manifest, { rootDir });
      const service = await queryService();
      const production = await readProductionStatus({ rootDir });
      log(JSON.stringify({ at: now(), service: service.state, production: production.state, translated: production.translated, total: production.total, reservedRecoveryRequests: ledger.reservedRequests }));
      if (production.state === 'completed' && ['inactive', 'failed', 'missing'].includes(service.state)) {
        const steps = ['merge', 'convert', 'build', 'test:browser'];
        if (!production.translationComplete || production.translated !== production.total || !production.total ||
            !Array.isArray(production.finalization) || production.finalization.length !== steps.length ||
            production.finalization.some((step, index) => step.script !== steps[index] || step.exitCode !== 0)) {
          review('FALSE_COMPLETION', 'Production completion does not match actual full coverage and all four successful verification steps.');
        }
        ledger.state = 'completed'; ledger.finishedAt = now(); await persist(); return ledger;
      }
      if (['active', 'activating', 'deactivating'].includes(service.state)) {
        try { await sleep(controller.signal); } catch (error) { if (!controller.signal.aborted) throw error; }
        continue;
      }
      if (!['inactive', 'failed'].includes(service.state) || service.pid !== 0 || production.state !== 'failed') review('SERVICE_STATE_UNKNOWN', 'Recovery requires a stopped translation service and failed production state.');
      await requireNoShardLocks(rootDir);
      const releaseProduction = await acquireProductionLock(rootDir);
      try {
        const confirmed = await queryService();
        if (!['inactive', 'failed'].includes(confirmed.state) || confirmed.pid !== 0) review('SERVICE_BECAME_ACTIVE', 'The translation service became active during recovery preflight.');
        const inputs = await recoveryInputs(rootDir, manifest);
        const candidates = planRecovery({ ...inputs, ledger });
        const roundId = randomUUID();
        ledger.state = 'recovering';
        const environment = { ...process.env, DEEPSEEK_API_KEY_FILE: manifest.authSourceFile,
          DEEPSEEK_BASE_URL: manifest.config.baseUrl, DEEPSEEK_MODEL: manifest.config.model,
          DEEPSEEK_REASONING_EFFORT: manifest.config.reasoningEffort,
          DEEPSEEK_MAX_TOKENS: String(manifest.config.maxTokens), DEEPSEEK_TIMEOUT_MS: String(manifest.config.timeoutMs) };
        delete environment.DEEPSEEK_API_KEY;
        const pool = await runWorkerPool(candidates, {
          workers: RECOVERY_POLICY.maxWorkers, shouldStop: () => controller.signal.aborted,
          run: async (candidate, control) => {
            if (control.shouldStop()) return { code: 130 };
            // A durable reservation precedes spawning and is never removed or refunded on a crash.
            const entry = { ...candidate, roundId, state: 'reserved', reservedAt: now() };
            ledger.attempts.push(entry); ledger.reservedRequests += 1; await persist();
            if (control.shouldStop()) { entry.state = 'interrupted'; await persist(); return { code: 130 }; }
            const result = await runChild(process.execPath, ['--env-file-if-exists=.env', 'scripts/translate.mjs',
              '--shard', `${candidate.index}/8`, '--limit', String(candidate.sourceCount), '--retry-failed',
              '--model', manifest.config.model, '--reasoning-effort', manifest.config.reasoningEffort,
            ], { rootDir, env: environment, kind: 'bounded-retry', index: candidate.index, activeChildren });
            const after = (await readRecoveryRecords(rootDir))[candidate.index];
            const newRecords = after.filter((record) => !candidate.priorRequestIds.includes(record.requestId));
            const original = after.find((record) => record.requestId === candidate.failedRequestId);
            const record = newRecords[0];
            const wrapper = await json(join(rootDir, `generated/shards/zh-Hans-${candidate.index}-of-8.json`));
            const byHash = new Map(inputs.source.map((text) => [hash(text), text]));
            const success = result.code === 0 && original && hash(JSON.stringify(original)) === candidate.failedRecordHash &&
              newRecords.length === 1 && record.type === 'completed' && record.identityHash === candidate.identityHash &&
              same(record.identity, original.identity) && hasKnownUsage(record) && record.httpStatus === 200 && record.finishReason === 'stop' &&
              record.model === original.model && record.reasoningEffort === original.reasoningEffort && record.maxTokens === original.maxTokens &&
              record.timeoutMs === original.timeoutMs && record.sourceCount === original.sourceCount && record.promptHash === original.promptHash &&
              same(record.contextHashes, original.contextHashes) &&
              record.sourceHash === candidate.sourceHash && same(record.textHashes, candidate.textHashes) &&
              record.reviewedPreviousRequestIds?.includes(candidate.failedRequestId) && unresolvedRecords(after).length === 0 &&
              Array.isArray(record.translations) && record.translations.length === candidate.sourceCount &&
              candidate.textHashes.every((textHash, offset) => typeof record.translations[offset] === 'string' && record.translations[offset].trim() && wrapper.translations?.[byHash.get(textHash)] === record.translations[offset]);
            Object.assign(entry, { state: success ? 'completed' : controller.signal.aborted ? 'interrupted' : 'needs-review', finishedAt: now(), exitCode: result.code,
              newRequestIds: newRecords.map((item) => item.requestId),
              ...(success ? { completedRequestId: record.requestId, completedRecordHash: hash(JSON.stringify(record)) } : {}) });
            await persist();
            if (!success) signalActiveChildren(activeChildren);
            return { code: success ? 0 : 1 };
          },
        });
        if (controller.signal.aborted) break;
        if (pool.failed) review('RETRY_FAILED', 'A bounded exact-batch retry did not complete with one matching journal record and saved translations.');
        ledger.state = 'restarting';
        ledger.restarts.push({ roundId, state: 'reserved', at: now() });
        await persist();
      } finally { await releaseProduction(); }
      if (controller.signal.aborted) break;
      await validateFrozenManifest(manifest, { rootDir });
      const beforeResume = await queryService();
      if (['active', 'activating', 'deactivating'].includes(beforeResume.state)) {
        ledger.restarts.at(-1).state = 'already-active';
      } else {
        if (!['inactive', 'failed'].includes(beforeResume.state) || beforeResume.pid !== 0) review('SERVICE_STATE_UNKNOWN', 'The translation service cannot safely be resumed.');
        await requireNoShardLocks(rootDir);
        if (controller.signal.aborted) break;
        await resumeService();
        ledger.restarts.at(-1).state = 'start-requested';
      }
      ledger.restarts.at(-1).finishedAt = now(); ledger.state = 'monitoring'; await persist();
      try { await sleep(controller.signal); } catch (error) { if (!controller.signal.aborted) throw error; }
    }
    ledger.state = 'interrupted'; ledger.finishedAt = now(); await persist(); return ledger;
  } catch (error) {
    if (ledger) {
      ledger.state = 'needs-review'; ledger.errorCode = error instanceof RecoveryReviewRequired ? error.code : 'RECOVERY_OPERATION_FAILED'; ledger.finishedAt = now();
      try { await persist(); } catch { /* Existing reservations remain authoritative even when the last status cannot be written. */ }
      return ledger;
    }
    throw error;
  } finally {
    await writes.catch(() => {});
    signal?.removeEventListener('abort', stop);
    if (manageSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--execute', '--status', '--help'].includes(args[0]))) review('INVALID_ARGUMENTS', 'Use --status (default) or --execute.');
    if (args[0] === '--help') console.log('Usage: node scripts/follow-through.mjs [--status | --execute]\nDefault is read-only status. --execute monitors the existing translation service every 30 seconds and permits at most one exact-batch retry for a known-usage HTTP 200 schema failure, with a persistent cap of 20 retry requests.');
    else if (args[0] === '--execute') { const result = await runFollowThrough(); console.log(JSON.stringify(result, null, 2)); if (result.state !== 'completed') process.exitCode = 1; }
    else console.log(JSON.stringify(await readFollowThroughStatus(), null, 2));
  } catch (error) {
    console.error(error instanceof RecoveryReviewRequired ? `Follow-through stopped [${error.code}]: ${error.message}` : 'Follow-through stopped: production state could not be safely verified.');
    process.exitCode = 1;
  }
}
