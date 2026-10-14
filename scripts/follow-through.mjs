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
import { assertLegacyTranslationAllowed } from '../lib/translation-retirement.mjs';
import { loadTranslationContexts } from '../lib/translation-context.mjs';
import { SIMPLIFIED_TERMINOLOGY_HASH, TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { TRANSLATION_PROMPT_TEMPLATE_HASH, TRANSLATION_PROMPT_VERSION } from '../lib/translator.mjs';
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

async function queryServiceUnit(unit) {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID'], { timeout: 10000, maxBuffer: 16384 }));
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

export const queryTranslationService = () => queryServiceUnit(RECOVERY_POLICY.unit);
export const queryFollowThroughService = () => queryServiceUnit('musicmap-follow-through.service');

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

const attemptSnapshot = ({ manualResolution, manualResolutionHash, ...entry }) => entry;
const recordEvidence = (record) => ({ requestId: record.requestId, recordHash: hash(JSON.stringify(record)) });
const resolvedAttempt = (entry) => entry.state === 'completed' || (entry.state === 'needs-review' && entry.manualResolution);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

function validateManualRecord(record, { identity, manifest, source, contexts }, index) {
  if (!record || !same(record.identity, identity) || record.identityHash !== hash(JSON.stringify(identity)) ||
      record.model !== manifest.config.model || record.reasoningEffort !== manifest.config.reasoningEffort ||
      record.maxTokens !== manifest.config.maxTokens || record.timeoutMs !== manifest.config.timeoutMs || record.language !== 'zh-Hans' ||
      (record.returnedModel !== null && record.returnedModel !== manifest.config.model) ||
      (record.returnedEffort !== null && record.returnedEffort !== manifest.config.reasoningEffort) ||
      record.promptVersion !== TRANSLATION_PROMPT_VERSION || record.promptTemplateHash !== TRANSLATION_PROMPT_TEMPLATE_HASH ||
      record.terminologyHash !== SIMPLIFIED_TERMINOLOGY_HASH || !validHash(record.promptHash)) {
    review('CONFIGURATION_MISMATCH', 'Manual recovery evidence does not match the frozen translation configuration.');
  }
  if (!hasKnownUsage(record)) review('UNKNOWN_USAGE', 'Manual recovery requires complete, consistent usage for every evidenced request.');
  if (record.httpStatus !== 200 || record.finishReason !== 'stop' ||
      !(timestamp(record.startedAt) <= timestamp(record.finishedAt))) review('INVALID_MANUAL_EVIDENCE', 'Manual recovery evidence has an invalid response or time interval.');
  const byHash = new Map(source.map((text) => [hash(text), text]));
  const texts = record.textHashes?.map((value) => byHash.get(value));
  if (!Array.isArray(texts) || !Number.isSafeInteger(record.sourceCount) || record.sourceCount < 1 || record.sourceCount > 20 ||
      texts.length !== record.sourceCount || new Set(record.textHashes).size !== texts.length ||
      texts.some((text) => text === undefined || shardForText(text, 8) !== index) ||
      hash(JSON.stringify(texts)) !== record.sourceHash ||
      !same(texts.map((text) => hash(contexts.get(text) ?? '')), record.contextHashes)) {
    review('INVALID_MANUAL_EVIDENCE', 'Manual recovery evidence has changed source fragments or context.');
  }
  return texts;
}

/** Recheck immutable evidence and saved translations on every later monitor iteration. */
export function validateManualResolution(entry, inputs) {
  const resolution = entry.manualResolution;
  if (entry.state !== 'needs-review' || !resolution || resolution.schemaVersion !== 1 ||
      entry.manualResolutionHash !== hash(JSON.stringify(resolution)) ||
      resolution.attemptHash !== hash(JSON.stringify(attemptSnapshot(entry))) ||
      resolution.manifestHash !== hash(JSON.stringify(inputs.manifest)) || resolution.failedRequestId !== entry.failedRequestId ||
      !Number.isFinite(timestamp(resolution.acknowledgedAt)) ||
      !Array.isArray(resolution.failedRetryRecords) || resolution.failedRetryRecords.length !== 1 ||
      !Array.isArray(resolution.completedRecords) || !resolution.completedRecords.length) {
    review('MANUAL_RESOLUTION_CHANGED', 'The manual resolution or its original reservation has changed.');
  }
  const records = inputs.recordsByShard[entry.index] ?? [];
  const getEvidence = (evidence) => {
    const record = records.find((item) => item.requestId === evidence?.requestId);
    if (!record || hash(JSON.stringify(record)) !== evidence.recordHash) review('JOURNAL_TAMPERED', 'A manual recovery journal record changed or disappeared.');
    return record;
  };
  const original = getEvidence({ requestId: entry.failedRequestId, recordHash: entry.failedRecordHash });
  validateManualRecord(original, inputs, entry.index);
  if (original.type !== 'failed' || original.errorCode !== 'INVALID_TRANSLATION' ||
      entry.identityHash !== original.identityHash || entry.sourceHash !== original.sourceHash ||
      entry.sourceCount !== original.sourceCount || !same(entry.textHashes, original.textHashes) ||
      entry.batchKey !== hash(`${original.identityHash}:${original.sourceHash}`) ||
      !(timestamp(original.finishedAt) <= timestamp(entry.reservedAt))) review('INVALID_MANUAL_EVIDENCE', 'The original failed batch does not match its reservation.');
  const retry = getEvidence(resolution.failedRetryRecords[0]);
  validateManualRecord(retry, inputs, entry.index);
  if (!same(entry.newRequestIds, [retry.requestId]) ||
      (entry.newRequestRecords && !same(entry.newRequestRecords, resolution.failedRetryRecords)) ||
      retry.type !== 'failed' || retry.errorCode !== 'INVALID_TRANSLATION' || retry.sourceHash !== original.sourceHash ||
      !same(retry.textHashes, original.textHashes) || retry.promptHash !== original.promptHash ||
      !retry.reviewedPreviousRequestIds?.includes(original.requestId) ||
      !(timestamp(retry.startedAt) >= timestamp(entry.reservedAt) && timestamp(retry.finishedAt) <= timestamp(entry.finishedAt))) {
    review('INVALID_MANUAL_EVIDENCE', 'The failed automatic retry does not match the retained reservation.');
  }
  try { validateShardWrapper(inputs.shards[entry.index], { sourceHash: inputs.manifest.frozen.sourceHash, source: inputs.source, language: 'zh-Hans', shard: { index: entry.index, count: 8 } }); }
  catch { review('SHARD_MISMATCH', 'The manually recovered shard no longer matches its frozen source assignment.'); }
  const covered = new Set();
  const ids = new Set();
  let reviewedRetry = false;
  for (const evidence of resolution.completedRecords) {
    const record = getEvidence(evidence);
    const texts = validateManualRecord(record, inputs, entry.index);
    if (ids.has(record.requestId) || entry.priorRequestIds?.includes(record.requestId) || record.type !== 'completed' || record.errorCode !== null ||
        !(timestamp(record.startedAt) >= timestamp(entry.finishedAt) && timestamp(record.finishedAt) <= timestamp(resolution.acknowledgedAt)) ||
        !Array.isArray(record.translations) || record.translations.length !== texts.length) {
      review('INVALID_MANUAL_EVIDENCE', 'Manual output must come from distinct, subsequent completed requests.');
    }
    ids.add(record.requestId);
    reviewedRetry ||= record.reviewedPreviousRequestIds?.includes(retry.requestId) ?? false;
    texts.forEach((text, offset) => {
      const textHash = record.textHashes[offset];
      if (!original.textHashes.includes(textHash) || covered.has(textHash)) review('MANUAL_COVERAGE_MISMATCH', 'Manual output must cover each original fragment exactly once.');
      if (typeof record.translations[offset] !== 'string' || !record.translations[offset].trim() ||
          inputs.shards[entry.index].translations[text] !== record.translations[offset]) review('MANUAL_OUTPUT_MISMATCH', 'Manual output does not match the saved shard translation.');
      covered.add(textHash);
    });
  }
  if (!reviewedRetry || covered.size !== original.sourceCount) review('MANUAL_COVERAGE_MISMATCH', 'The original failed batch lacks complete, explicitly reviewed manual output.');
  // Validate all review references, without suppressing later unrelated failures.
  unresolvedRecords(records);
}

function validateRecoveryHistory(inputs, ledger) {
  for (const entry of ledger.attempts) {
    const records = inputs.recordsByShard[entry.index] ?? [];
    const original = records.find((record) => record.requestId === entry.failedRequestId);
    if (!original || hash(JSON.stringify(original)) !== entry.failedRecordHash) review('JOURNAL_TAMPERED', 'An already reviewed failed request changed or disappeared.');
    if (entry.manualResolution || entry.manualResolutionHash) validateManualResolution(entry, inputs);
    else if (entry.state === 'completed') {
      const completed = records.find((record) => record.requestId === entry.completedRequestId);
      if (!completed || hash(JSON.stringify(completed)) !== entry.completedRecordHash) review('JOURNAL_TAMPERED', 'A recorded successful bounded retry changed or disappeared.');
    }
  }
}

/** Pure policy gate: select only one known-cost schema-failure retry for the unchanged first missing batch. */
export function planRecovery({ recordsByShard, manifest, source, shards, identity, contexts, ledger }) {
  validateLedger(ledger, manifest);
  if (ledger.state === 'needs-review' || ledger.attempts.some((attempt) => !resolvedAttempt(attempt))) review('PRIOR_RETRY_UNRESOLVED', 'A prior recovery attempt was interrupted or needs review; its reserved request budget is retained.');
  if (ledger.reservedRequests >= RECOVERY_POLICY.maxRequests) review('RECOVERY_CAP', 'The persistent twenty-request recovery cap has been reached.');
  validateRecoveryHistory({ recordsByShard, manifest, source, shards, identity, contexts }, ledger);
  const expectedIdentityHash = hash(JSON.stringify(identity));
  const candidates = [];
  for (let index = 1; index <= 8; index += 1) {
    const records = recordsByShard[index] ?? [];
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

/** Local acknowledgement only: never invokes a model, child translator, or service start. */
export async function acknowledgeManualRecovery({ rootDir = PROJECT_ROOT, failedRequestId,
  queryService = queryTranslationService, queryMonitor = queryFollowThroughService } = {}) {
  const release = await acquireFollowThroughLock(rootDir);
  try {
    const requireStopped = async () => {
      for (const service of [await queryService(), await queryMonitor()]) {
        if (!['inactive', 'failed', 'missing'].includes(service.state) || service.pid !== 0) review('SERVICE_BECAME_ACTIVE', 'Both translation and follow-through services must be stopped for manual acknowledgement.');
      }
      await requireNoShardLocks(rootDir);
    };
    await requireStopped();
    const releaseProduction = await acquireProductionLock(rootDir);
    try {
      await requireStopped();
      const manifest = await json(join(base(rootDir), 'manifest.json'));
      const ledger = await json(ledgerPath(rootDir));
      validateLedger(ledger, manifest);
      const entry = ledger.attempts.find((item) => item.failedRequestId === failedRequestId);
      if (ledger.state !== 'needs-review' || !entry || entry.state !== 'needs-review' || entry.manualResolution ||
          !Array.isArray(entry.newRequestIds) || entry.newRequestIds.length !== 1 ||
          ledger.attempts.some((item) => item !== entry && !resolvedAttempt(item))) {
        review('MANUAL_TARGET_INVALID', 'Supply the original failedRequestId of the sole unresolved automatic retry; existing reservations are retained.');
      }
      const inputs = await recoveryInputs(rootDir, manifest);
      const records = inputs.recordsByShard[entry.index];
      const retry = records.find((record) => record.requestId === entry.newRequestIds[0]);
      if (!retry) review('JOURNAL_TAMPERED', 'The failed automatic retry journal is missing.');
      for (const group of Object.values(inputs.recordsByShard)) {
        if (unresolvedRecords(group).length) review('UNRESOLVED_JOURNAL', 'All shard journals must be resolved before manual acknowledgement.');
        if (group.some((record) => !hasKnownUsage(record))) review('UNKNOWN_USAGE', 'Every recorded request must have known, consistent usage before manual acknowledgement.');
      }
      const completed = records.filter((record) => record.type === 'completed' && record.textHashes?.some((value) => entry.textHashes.includes(value)));
      entry.manualResolution = { schemaVersion: 1, acknowledgedAt: now(), failedRequestId,
        attemptHash: hash(JSON.stringify(attemptSnapshot(entry))), manifestHash: ledger.manifestHash,
        previousLedgerErrorCode: ledger.errorCode ?? null,
        failedRetryRecords: [recordEvidence(retry)], completedRecords: completed.map(recordEvidence) };
      entry.manualResolutionHash = hash(JSON.stringify(entry.manualResolution));
      validateRecoveryHistory(inputs, ledger);
      // Re-read all evidence while holding both coordination locks before the only ledger write.
      const confirmed = await recoveryInputs(rootDir, manifest);
      validateRecoveryHistory(confirmed, ledger);
      for (const group of Object.values(confirmed.recordsByShard)) {
        if (unresolvedRecords(group).length) review('UNRESOLVED_JOURNAL', 'A new unresolved request appeared during acknowledgement.');
        if (group.some((record) => !hasKnownUsage(record))) review('UNKNOWN_USAGE', 'Request usage changed during acknowledgement.');
      }
      await requireStopped();
      ledger.state = 'monitoring'; ledger.updatedAt = now();
      delete ledger.errorCode; delete ledger.finishedAt;
      await atomicJson(ledgerPath(rootDir), ledger);
      return ledger;
    } finally { await releaseProduction(); }
  } finally { await release(); }
}

export async function readFollowThroughStatus({ rootDir = PROJECT_ROOT } = {}) {
  return { recovery: await json(ledgerPath(rootDir), true) ?? { state: 'not-started', reservedRequests: 0, policy: RECOVERY_POLICY }, production: await readProductionStatus({ rootDir }) };
}

export async function runFollowThrough({ rootDir = PROJECT_ROOT, queryService = queryTranslationService,
  resumeService = startTranslationService, runChild = runChildProcess,
  sleep = (signal) => delay(RECOVERY_POLICY.pollMs, undefined, { signal }), signal,
  manageSignals = true, log = console.log } = {}) {
  await assertLegacyTranslationAllowed(rootDir);
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
    if (ledger.state === 'needs-review' || ledger.attempts.some((attempt) => !resolvedAttempt(attempt))) review('PRIOR_RETRY_UNRESOLVED', 'A previous bounded retry remains unresolved. No new paid request was started.');
    while (!controller.signal.aborted) {
      await validateFrozenManifest(manifest, { rootDir });
      if (ledger.attempts.some((entry) => entry.manualResolution || entry.manualResolutionHash)) validateRecoveryHistory(await recoveryInputs(rootDir, manifest), ledger);
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
              newRequestRecords: newRecords.map(recordEvidence),
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
    const acknowledge = args.length === 2 && args[0] === '--acknowledge-manual-recovery' && /^[a-zA-Z0-9-]{1,100}$/.test(args[1]);
    if (!acknowledge && (args.length > 1 || (args.length === 1 && !['--execute', '--status', '--help'].includes(args[0])))) review('INVALID_ARGUMENTS', 'Use --status, --execute, or --acknowledge-manual-recovery ORIGINAL_FAILED_REQUEST_ID.');
    if (args[0] === '--help') console.log('Usage: node scripts/follow-through.mjs [--status | --execute | --acknowledge-manual-recovery ORIGINAL_FAILED_REQUEST_ID]\nDefault is read-only status. --execute permits one exact-batch retry for a known-usage HTTP 200 schema failure, with a persistent cap of 20 automatic retry reservations. Manual acknowledgement validates completed journals and saved output, then updates only the local ledger; it never calls an API or starts a service.');
    else if (acknowledge) console.log(JSON.stringify(await acknowledgeManualRecovery({ failedRequestId: args[1] }), null, 2));
    else if (args[0] === '--execute') { const result = await runFollowThrough(); console.log(JSON.stringify(result, null, 2)); if (result.state !== 'completed') process.exitCode = 1; }
    else console.log(JSON.stringify(await readFollowThroughStatus(), null, 2));
  } catch (error) {
    console.error(error instanceof RecoveryReviewRequired ? `Follow-through stopped [${error.code}]: ${error.message}` : 'Follow-through stopped: production state could not be safely verified.');
    process.exitCode = 1;
  }
}
