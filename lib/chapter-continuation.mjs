import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, PROJECT_ROOT, shardForText, validateShardWrapper } from '../scripts/translate.mjs';
import { acquireTranslationLock, createTranslationJournal, readTranslationKey } from './translation-journal.mjs';
import { createTranslator, CHAPTER_PROMPT_TEMPLATE_HASH } from './translator.mjs';
import { validateUnitCatalog, validateChapterTranslation } from './chapter-units.mjs';
import { TERMINOLOGY_HASH, SIMPLIFIED_TERMINOLOGY_HASH } from './terminology.mjs';
import { PILOT_ID, PILOT_RUN, PILOT_CONFIG } from './chapter-pilot.mjs';
import { recoverChapterFormat, recoverReviewedDuplicateBold, recoverReviewedMissingBold, recoverReviewedMissingBoldPair, recoverReviewedParagraphBoundaries } from './chapter-format-recovery.mjs';

export const CONTINUATION_ID = 'whole-body-pro-max-50pct-v1';
export const CONTINUATION_RUN = 'artifacts/chapter-continuation/2026-10-14-body-50pct';
export const BODY_TOTAL = 562, BODY_TARGET = 281, NEW_ATTEMPT_LIMIT = 271;
export const CONTINUATION_CONFIG = Object.freeze({ ...PILOT_CONFIG, maxAttempts: NEW_ATTEMPT_LIMIT });
const EXTRA_PROGRAM = ['lib/chapter-continuation.mjs', 'lib/chapter-format-recovery.mjs', 'scripts/continue-chapters.mjs', 'server.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const ledgerPath = root => join(root, 'generated/production/chapter-continuation-50pct.json');
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function json(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function hashes(root, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async file => [file, hash(await readFile(join(root, file)))])));
}
async function verifyHashes(root, expected) {
  if (!same(await hashes(root, Object.keys(expected)), expected)) fail('FROZEN_INPUT_CHANGED', 'Frozen code, source, terminology, prior evidence, or pricing changed; no request allowed.');
}
function descriptor(unit) {
  return { unitId: unit.id, chapterId: unit.genreId ?? unit.id, sourceHash: hash(unit.source),
    shard: shardForText(unit.source, 8), paragraphs: unit.paragraphs.length, characters: unit.source.length };
}
export function selectContinuationUnits(catalog, retainedSources) {
  validateUnitCatalog(catalog);
  const unique = [...new Map(catalog.units.map(u => [u.source, u])).keys()];
  const seen = new Set();
  const ordered = catalog.units.filter(u => { if (seen.has(u.source)) return false; seen.add(u.source); return true; });
  if (unique.length !== BODY_TOTAL || catalog.units.length !== 572 || catalog.source.length - unique.length !== 1338
    || retainedSources.size !== 10 || [...retainedSources].some(s => !seen.has(s))) {
    fail('BODY_DENOMINATOR_MISMATCH', 'Expected exactly 562 unique body sources, 572 mappings, 1338 UI keys, and 10 retained body sources.');
  }
  const selected = ordered.filter(u => !retainedSources.has(u.source)).slice(0, NEW_ATTEMPT_LIMIT);
  if (selected.length + retainedSources.size !== BODY_TARGET) fail('BODY_SELECTION_INVALID', 'The fixed selection must reach exactly 281 unique body sources.');
  for (const unit of selected) {
    validateChapterTranslation(unit.source, unit.source);
    if (unit.source.length > 5000) fail('CHAPTER_TOO_LONG', 'A complete body unit exceeds the unchanged input limit.');
  }
  return selected;
}
function knownUsage(record) {
  const u = record?.rawUsage;
  return !!u && ['prompt_tokens', 'completion_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)
    && (u.total_tokens == null || u.total_tokens === u.prompt_tokens + u.completion_tokens)
    && (u.completion_tokens_details?.reasoning_tokens == null || (Number.isSafeInteger(u.completion_tokens_details.reasoning_tokens)
      && u.completion_tokens_details.reasoning_tokens >= 0 && u.completion_tokens_details.reasoning_tokens <= u.completion_tokens))
    && (u.prompt_cache_hit_tokens == null || (u.prompt_cache_hit_tokens >= 0 && u.prompt_cache_hit_tokens <= u.prompt_tokens))
    && (u.prompt_cache_miss_tokens == null || (u.prompt_cache_miss_tokens >= 0 && u.prompt_cache_miss_tokens <= u.prompt_tokens))
    && (u.prompt_cache_hit_tokens == null || u.prompt_cache_miss_tokens == null || u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens === u.prompt_tokens);
}
function verifyRecord(record, manifest, unit, { prior = false, completed = true } = {}) {
  const idKey = prior ? 'pilot' : 'continuation';
  if (!record || record.type !== (completed ? 'completed' : 'failed') || record.model !== PILOT_CONFIG.model
    || record.returnedModel !== PILOT_CONFIG.model || (record.returnedEffort && record.returnedEffort !== 'max')
    || record.reasoningEffort !== 'max' || record.maxTokens !== 32768 || record.timeoutMs !== 600000
    || record.language !== 'zh-Hans' || record.sourceCount !== 1 || record.httpStatus !== 200 || !knownUsage(record)
    || record.identity?.[idKey] !== (prior ? PILOT_ID : CONTINUATION_ID)
    || record.identity?.catalogHash !== manifest.catalogHash || record.identity?.sourceHash !== manifest.sourceHash
    || record.identity?.terminologyHash !== TERMINOLOGY_HASH || record.terminologyHash !== SIMPLIFIED_TERMINOLOGY_HASH
    || record.promptTemplateHash !== CHAPTER_PROMPT_TEMPLATE_HASH || record.sourceHash !== hash(JSON.stringify([unit.source]))
    || !same(record.textHashes, [hash(unit.source)]) || record.requestSent !== true
    || record.identityHash !== hash(JSON.stringify(record.identity))) {
    fail('JOURNAL_IDENTITY_OR_USAGE_INVALID', 'Paid journal does not match the frozen whole-body request and known usage.');
  }
  if (completed) {
    if (record.finishReason !== 'stop' || record.translations?.length !== 1) fail('JOURNAL_INVALID', 'Completed journal has no complete translation.');
    validateChapterTranslation(unit.source, record.translations[0]);
  }
}
async function parentSnapshot(rootDir) {
  const run = join(rootDir, PILOT_RUN), workspace = join(run, 'workspace');
  const manifest = await json(join(run, 'manifest.json'));
  const ledger = await json(join(rootDir, 'generated/production/chapter-pilot.json'));
  if (ledger.id !== PILOT_ID || ledger.state !== 'awaiting-review' || ledger.attempts.length !== 10
    || ledger.maxAttempts !== 10 || !same(manifest.config, PILOT_CONFIG)
    || ledger.manifestHash !== hash(await readFile(join(run, 'manifest.json')))
    || !same(ledger, await json(join(run, 'quota-ledger.json')))) fail('PRIOR_PILOT_INVALID', 'The original ten-attempt evidence must remain intact and complete.');
  await verifyHashes(rootDir, manifest.program);
  await verifyHashes(workspace, { ...manifest.program, ...manifest.inputs });
  const registry = await json(join(workspace, '.cache/source/units.json'));
  validateUnitCatalog(registry);
  if (hash(JSON.stringify(registry)) !== manifest.catalogHash || registry.sourceHash !== manifest.sourceHash
    || manifest.terminologyHash !== TERMINOLOGY_HASH || manifest.promptTemplateHash !== CHAPTER_PROMPT_TEMPLATE_HASH) fail('PRIOR_CATALOG_INVALID', 'Pilot source or prompt identity differs.');
  const evidencePaths = ['generated/production/chapter-pilot.json', `${PILOT_RUN}/manifest.json`, `${PILOT_RUN}/quota-ledger.json`];
  const retained = [];
  for (const [index, attempt] of ledger.attempts.entries()) {
    const unit = registry.units.find(u => u.id === attempt.unitId), selected = manifest.selected[index];
    if (attempt.state !== 'completed' || !unit || attempt.sourceHash !== hash(unit.source)
      || attempt.unitId !== selected.unitId || attempt.ordinal !== index + 1) fail('PRIOR_RESULT_INVALID', 'All ten prior whole-body results must be valid.');
    const file = `${PILOT_RUN}/workspace/${attempt.journalFile}`;
    const record = await json(join(rootDir, file));
    verifyRecord(record, manifest, unit, { prior: true });
    if (record.requestId !== attempt.requestId) fail('PRIOR_RESULT_INVALID', 'Prior request ID differs.');
    retained.push({ ...descriptor(unit), journalFile: file, journalHash: hash(await readFile(join(rootDir, file))), requestId: record.requestId });
    evidencePaths.push(file);
  }
  return { manifest, registry, retained, workspace, evidence: await hashes(rootDir, evidencePaths) };
}
export async function prepareChapterContinuation({ rootDir = PROJECT_ROOT } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  try {
    if (await json(ledgerPath(rootDir), true)) { await loadContinuation(rootDir); return readChapterContinuationStatus({ rootDir }); }
    const parent = await parentSnapshot(rootDir);
    const priorSources = new Set(parent.retained.map(x => parent.registry.units.find(u => u.id === x.unitId).source));
    const selected = selectContinuationUnits(parent.registry, priorSources).map(descriptor);
    const runDir = join(rootDir, CONTINUATION_RUN), workspace = join(runDir, 'workspace');
    if (await stat(runDir).catch(e => { if (e.code !== 'ENOENT') throw e; return null; })) fail('CONTINUATION_ALREADY_EXISTS', 'Continuation files exist without their ledger; inspect instead of resetting quota.');
    await mkdir(workspace, { recursive: true });
    for (const folder of ['lib', 'scripts', 'public', 'data', 'benchmarks', 'generated/site', '.cache/source']) {
      await cp(join(parent.workspace, folder), join(workspace, folder), { recursive: true });
    }
    for (const file of ['package.json', 'package-lock.json', 'server.mjs']) await cp(join(parent.workspace, file), join(workspace, file));
    for (const file of EXTRA_PROGRAM) await cp(join(rootDir, file), join(workspace, file));
    // The existing retirement guard understands this policy filename; legacy workers remain blocked.
    await atomicJson(join(workspace, 'generated/production/chapter-pilot-policy.json'), {
      id: CONTINUATION_ID, retiredFragmentEntry: true, maxAttempts: NEW_ATTEMPT_LIMIT, targetUniqueBodySources: BODY_TARGET });
    for (let index = 1; index <= 8; index++) await atomicJson(join(workspace, `generated/shards/zh-Hans-${index}-of-8.json`), {
      sourceHash: parent.manifest.sourceHash, language: 'zh-Hans', shard: { index, count: 8 }, translations: {} });
    for (const result of parent.retained) {
      const unit = parent.registry.units.find(u => u.id === result.unitId);
      const record = await json(join(rootDir, result.journalFile));
      await cp(join(rootDir, result.journalFile), join(runDir, 'retained-journals', `${result.requestId}.json`));
      await exportUnit(workspace, parent.registry, unit, record.translations[0]);
    }
    const manifest = { schemaVersion: 1, id: CONTINUATION_ID, createdAt: now(), config: CONTINUATION_CONFIG,
      authorization: { scope: 'all unique frozen body sources', denominator: BODY_TOTAL, target: BODY_TARGET,
        retained: 10, maxNewRequests: NEW_ATTEMPT_LIMIT, order: 'catalog.units first occurrence by exact source',
        retries: 0, uiKeysExcluded: 1338, reports: false, partialBuild: true },
      parentRun: PILOT_RUN, priorEvidence: parent.evidence, retained: parent.retained, selected,
      sourceHash: parent.manifest.sourceHash, catalogHash: parent.manifest.catalogHash,
      terminologyHash: TERMINOLOGY_HASH, promptTemplateHash: CHAPTER_PROMPT_TEMPLATE_HASH,
      authSourceFile: parent.manifest.authSourceFile, inputs: parent.manifest.inputs,
      program: await hashes(rootDir, [...Object.keys(parent.manifest.program), ...EXTRA_PROGRAM]) };
    await atomicJson(join(runDir, 'manifest.json'), manifest);
    await atomicJson(ledgerPath(rootDir), { schemaVersion: 1, id: CONTINUATION_ID, run: CONTINUATION_RUN,
      manifestHash: hash(await readFile(join(runDir, 'manifest.json'))), maxAttempts: NEW_ATTEMPT_LIMIT,
      target: BODY_TARGET, denominator: BODY_TOTAL, retained: 10, state: 'prepared', createdAt: now(), attempts: [] });
    await loadContinuation(rootDir);
    return readChapterContinuationStatus({ rootDir });
  } finally { await release(); }
}
function validateLedger(control, manifest) {
  if (!control || control.id !== CONTINUATION_ID || control.run !== CONTINUATION_RUN
    || control.maxAttempts !== NEW_ATTEMPT_LIMIT || control.target !== BODY_TARGET || control.denominator !== BODY_TOTAL
    || control.retained !== 10 || !Array.isArray(control.attempts) || control.attempts.length > NEW_ATTEMPT_LIMIT
    || control.attempts.some((a, i) => a.ordinal !== i + 1 || a.unitId !== manifest.selected[i]?.unitId
      || a.sourceHash !== manifest.selected[i]?.sourceHash || a.shard !== manifest.selected[i]?.shard
      || !['reserved', 'started', 'completed', 'failed', 'unknown', 'not-sent'].includes(a.state))) {
    fail('CONTINUATION_LEDGER_INVALID', 'Continuation quota or selection changed; no requests allowed.');
  }
}
async function loadContinuation(rootDir) {
  const control = await json(ledgerPath(rootDir));
  const runDir = join(rootDir, CONTINUATION_RUN), workspace = join(runDir, 'workspace');
  const bytes = await readFile(join(runDir, 'manifest.json')), manifest = JSON.parse(bytes);
  if (hash(bytes) !== control.manifestHash || manifest.id !== CONTINUATION_ID || !same(manifest.config, CONTINUATION_CONFIG)
    || manifest.promptTemplateHash !== CHAPTER_PROMPT_TEMPLATE_HASH || manifest.terminologyHash !== TERMINOLOGY_HASH
    || manifest.retained.length !== 10 || manifest.selected.length !== NEW_ATTEMPT_LIMIT) fail('CONTINUATION_MANIFEST_CHANGED', 'Continuation manifest changed.');
  validateLedger(control, manifest);
  await verifyHashes(rootDir, { ...manifest.program, ...manifest.priorEvidence });
  await verifyHashes(workspace, { ...manifest.program, ...manifest.inputs });
  const registry = await json(join(workspace, '.cache/source/units.json'));
  validateUnitCatalog(registry);
  if (hash(JSON.stringify(registry)) !== manifest.catalogHash || registry.sourceHash !== manifest.sourceHash) fail('CATALOG_CHANGED', 'Frozen body registry changed.');
  const retainedSources = new Set(manifest.retained.map(x => registry.units.find(u => u.id === x.unitId)?.source));
  const selected = selectContinuationUnits(registry, retainedSources);
  if (!same(selected.map(descriptor), manifest.selected)) fail('BODY_SELECTION_CHANGED', 'Selection no longer follows the frozen catalog order.');
  return { control, manifest, registry, units: selected, runDir, workspace };
}
async function exportUnit(workspace, registry, unit, translation) {
  validateChapterTranslation(unit.source, translation);
  const index = shardForText(unit.source, 8), file = join(workspace, `generated/shards/zh-Hans-${index}-of-8.json`);
  const wrapper = await json(file);
  validateShardWrapper(wrapper, { sourceHash: registry.sourceHash, source: registry.source, shard: { index, count: 8 } });
  if (Object.hasOwn(wrapper.translations, unit.source) && wrapper.translations[unit.source] !== translation) fail('EXPORT_CONFLICT', 'Export differs from the paid journal.');
  wrapper.translations[unit.source] = translation;
  await atomicJson(file, wrapper);
}
async function verifyExports(workspace, registry, expected) {
  const actual = new Map();
  for (let index = 1; index <= 8; index++) {
    const wrapper = await json(join(workspace, `generated/shards/zh-Hans-${index}-of-8.json`));
    validateShardWrapper(wrapper, { sourceHash: registry.sourceHash, source: registry.source, shard: { index, count: 8 } });
    for (const [source, translation] of Object.entries(wrapper.translations)) actual.set(source, translation);
  }
  if (actual.size !== expected.size || [...actual].some(([s, t]) => expected.get(s) !== t)) fail('UNPROVEN_EXPORT', 'Exports must contain only validated retained/new whole-body journals, never UI keys or old fragments.');
  if (actual.size > BODY_TARGET) fail('BODY_TARGET_EXCEEDED', 'Body target exceeded.');
}
async function recoverFailedRecord(loaded, attempt, unit, record) {
  const { manifest, workspace } = loaded;
  verifyRecord(record, manifest, unit, { completed: false });
  if (record.finishReason !== 'stop') return null;
  let candidate = recoverChapterFormat(unit.source, record.responseText);
  const reviewed = manifest.reviewedFormatCorrections?.find(r => r.requestId === record.requestId);
  if (!candidate && reviewed) {
    const bytes = await readFile(join(workspace, reviewed.file)), correction = JSON.parse(bytes);
    if (hash(bytes) !== reviewed.sha256 || correction.requestId !== record.requestId || correction.unitId !== unit.id
      || correction.sourceHash !== hash(unit.source) || correction.originalResponseHash !== hash(record.responseText)
      || correction.originalJournalHash !== hash(await readFile(join(workspace, attempt.journalFile)))) {
      fail('REVIEWED_CORRECTION_MISMATCH', 'Reviewed marker correction does not match this exact paid response.');
    }
    candidate = recoverReviewedDuplicateBold(unit, record.responseText, correction)
      ?? recoverReviewedMissingBold(unit, record.responseText, correction)
      ?? recoverReviewedMissingBoldPair(unit, record.responseText, correction)
      ?? recoverReviewedParagraphBoundaries(unit, record.responseText, correction);
    if (!candidate || hash(candidate.translation) !== correction.expectedCandidateHash) fail('REVIEWED_CORRECTION_INVALID', 'Reviewed candidate failed the unchanged source validator.');
    candidate.reviewedCorrectionFile = reviewed.file;
  }
  if (!candidate) return null;
  const recoveryFile = `generated/translation-recoveries/${record.requestId}.json`;
  const evidence = { schemaVersion: 1, type: 'local-format-recovery', continuation: CONTINUATION_ID,
    requestId: record.requestId, originalJournalFile: attempt.journalFile,
    originalJournalHash: hash(await readFile(join(workspace, attempt.journalFile))),
    unitId: unit.id, sourceHash: hash(unit.source), ...candidate };
  const previous = await json(join(workspace, recoveryFile), true);
  if (previous && !same(previous, evidence)) fail('RECOVERY_CHANGED', 'Local recovery evidence differs from its immutable failed journal.');
  if (!previous) await atomicJson(join(workspace, recoveryFile), evidence);
  attempt.recoveryFile = recoveryFile; attempt.originalFailure = record.errorCode; attempt.recoveryKind = candidate.kind;
  return candidate.translation;
}
async function reconcile(rootDir, loaded) {
  const { control, manifest, registry, units, workspace } = loaded, expected = new Map();
  for (const prior of manifest.retained) {
    const unit = registry.units.find(u => u.id === prior.unitId), record = await json(join(rootDir, prior.journalFile));
    verifyRecord(record, manifest, unit, { prior: true });
    expected.set(unit.source, record.translations[0]);
    await exportUnit(workspace, registry, unit, record.translations[0]);
  }
  for (const attempt of control.attempts) {
    const record = attempt.journalFile ? await json(join(workspace, attempt.journalFile), true) : null;
    const unit = units[attempt.ordinal - 1];
    if (record?.requestId !== attempt.requestId) fail('JOURNAL_ID_MISMATCH', 'Reserved request ID does not match its journal.');
    if (record?.type === 'completed') {
      verifyRecord(record, manifest, unit);
      expected.set(unit.source, record.translations[0]);
      await exportUnit(workspace, registry, unit, record.translations[0]);
      attempt.state = 'completed';
    } else if (record?.type === 'failed' && record.requestSent === false && record.errorCode === 'STOP_REQUESTED_BEFORE_SEND') {
      attempt.state = 'not-sent';
    } else if (record?.type === 'failed' && ['INVALID_TRANSLATION', 'INVALID_CHAPTER_STRUCTURE', 'INCOMPLETE_TRANSLATION'].includes(record.errorCode)) {
      verifyRecord(record, manifest, unit, { completed: false });
      const recovered = await recoverFailedRecord(loaded, attempt, unit, record);
      if (recovered) {
        expected.set(unit.source, recovered); await exportUnit(workspace, registry, unit, recovered); attempt.state = 'completed';
      } else attempt.state = 'failed';
    } else fail('UNRESOLVED_ATTEMPT', 'A reserved request has unknown usage/identity or unresolved failure; review before further spending.');
  }
  await verifyExports(workspace, registry, expected);
  return expected;
}
export async function readChapterContinuationStatus({ rootDir = PROJECT_ROOT } = {}) {
  const c = await json(ledgerPath(rootDir), true);
  if (!c) return { state: 'not-prepared', denominator: BODY_TOTAL, target: BODY_TARGET, maxNewRequests: NEW_ATTEMPT_LIMIT };
  const m = await json(join(rootDir, CONTINUATION_RUN, 'manifest.json')); validateLedger(c, m);
  const completed = c.attempts.filter(a => a.state === 'completed').length;
  return { id: c.id, state: c.state, bodyCompleted: 10 + completed, bodyTotal: BODY_TOTAL, target: BODY_TARGET,
    retained: 10, newCompleted: completed, newAttempts: c.attempts.length, maxNewRequests: NEW_ATTEMPT_LIMIT,
    failed: c.attempts.filter(a => a.state === 'failed').length,
    locallyRecovered: c.attempts.filter(a => a.recoveryFile).length,
    uncertain: c.attempts.filter(a => ['reserved', 'started', 'unknown'].includes(a.state)).length,
    unusedSlots: NEW_ATTEMPT_LIMIT - c.attempts.length, uiCounted: 0, lastError: c.lastError ?? null, run: CONTINUATION_RUN };
}
export async function executeChapterContinuation({ rootDir = PROJECT_ROOT, apiKey, fetchImpl = globalThis.fetch,
  manageSignals = true, shouldStop = () => false, log = console.log, afterJournal = async () => {} } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  let stopping = false;
  const stop = () => { stopping = true; log('Stop requested: finish current body unit, then stop.'); };
  if (manageSignals) { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  try {
    const loaded = await loadContinuation(rootDir), { control, manifest, registry, units, workspace, runDir } = loaded;
    const save = async () => { control.updatedAt = now(); await atomicJson(ledgerPath(rootDir), control); };
    let completed;
    try { completed = await reconcile(rootDir, loaded); }
    catch (error) { control.state = 'review-required'; control.lastError = error.code ?? 'LOCAL_FAILURE'; await save(); throw error; }
    await save();
    if (control.state === 'review-required') fail(control.lastError ?? 'REVIEW_REQUIRED', 'Review-required stop persists; completed journals can recover for free, no new call allowed.');
    const finish = async () => {
      control.state = completed.size === BODY_TARGET ? 'target-reached' : control.attempts.length === NEW_ATTEMPT_LIMIT ? 'quota-exhausted-shortfall' : 'paused';
      await save();
      await atomicJson(join(runDir, 'stop-marker.json'), { id: CONTINUATION_ID, stoppedAt: now(), state: control.state,
        bodyCompleted: completed.size, denominator: BODY_TOTAL, target: BODY_TARGET, newAttempts: control.attempts.length,
        maxNewRequests: NEW_ATTEMPT_LIMIT, retries: 0, uiCounted: 0 });
      return readChapterContinuationStatus({ rootDir });
    };
    if (completed.size === BODY_TARGET || control.attempts.length === NEW_ATTEMPT_LIMIT) return finish();
    const key = await readTranslationKey({ apiKey, apiKeyFile: apiKey === undefined ? manifest.authSourceFile : undefined });
    if (!key) fail('API_KEY_MISSING', 'Continuation API key is missing.');
    control.state = 'running'; await save();
    while (completed.size < BODY_TARGET && control.attempts.length < NEW_ATTEMPT_LIMIT && !stopping && !shouldStop()) {
      const ordinal = control.attempts.length + 1, selected = manifest.selected[ordinal - 1], unit = units[ordinal - 1];
      const scope = `body-${ordinal}-${hash(unit.id).slice(0, 12)}`;
      const identity = { continuation: CONTINUATION_ID, sourceHash: manifest.sourceHash, catalogHash: manifest.catalogHash,
        chapterId: selected.chapterId, unitId: unit.id, model: PILOT_CONFIG.model, reasoningEffort: 'max', maxTokens: 32768,
        promptTemplateHash: CHAPTER_PROMPT_TEMPLATE_HASH, terminologyHash: TERMINOLOGY_HASH };
      const journal = await createTranslationJournal({ rootDir: workspace, scope, identity, source: [unit.source] });
      if (Object.keys(journal.recovered).length) fail('UNRESERVED_JOURNAL', 'Unreserved completed request exists; no new request may be sent.');
      const attempt = { ...selected, ordinal, state: 'reserved', reservedAt: now(), requestId: null, journalFile: null };
      control.attempts.push(attempt); await save();
      const shardRelease = await acquireTranslationLock(workspace, `zh-Hans-${selected.shard}-of-8`);
      let finalRecord = null;
      try {
        const translator = createTranslator({ apiKey: key, ...CONTINUATION_CONFIG, fetchImpl,
          cacheDir: join(workspace, '.cache/translations'), shouldStop: () => stopping || shouldStop(),
          onRequest: async event => {
            if (event.type === 'started') {
              if (attempt.requestId !== null) fail('REQUEST_LIMIT', 'One reservation allows only one request.');
              attempt.requestId = event.requestId; attempt.journalFile = `generated/translation-requests/${scope}/${event.requestId}.json`;
              attempt.state = 'started'; await save();
            }
            await journal.record(event);
            if (event.type !== 'started') finalRecord = await json(join(workspace, attempt.journalFile));
          } });
        const context = `Complete chapter: ${unit.title}. Genre code: ${selected.chapterId}. Registry: ${manifest.catalogHash}.`;
        const result = await translator.translate({ language: 'zh-Hans', texts: [unit.source], contexts: [context] });
        if (!finalRecord || result.cached) fail('UNEXPECTED_CACHE_HIT', 'Fresh continuation units require their own durable paid journal.');
        verifyRecord(finalRecord, manifest, unit);
        await afterJournal({ ordinal, record: finalRecord });
        await exportUnit(workspace, registry, unit, result.translations[0]); completed.set(unit.source, result.translations[0]);
        attempt.state = 'completed'; attempt.finishedAt = now(); await save();
        log(`${now()} Body ${completed.size}/${BODY_TOTAL}; target ${BODY_TARGET}; new request ${ordinal}/${NEW_ATTEMPT_LIMIT} ${unit.id}: complete; ${finalRecord.normalizedUsage.total} tokens.`);
      } catch (error) {
        attempt.errorCode = error.code ?? 'LOCAL_OPERATION_FAILED'; attempt.finishedAt = now();
        if (error.code === 'STOP_REQUESTED_BEFORE_SEND' && finalRecord?.requestSent === false) {
          attempt.state = 'not-sent'; await save(); break;
        } else if (finalRecord?.type === 'failed' && ['INVALID_TRANSLATION', 'INVALID_CHAPTER_STRUCTURE', 'INCOMPLETE_TRANSLATION'].includes(finalRecord.errorCode) && knownUsage(finalRecord)) {
          try { verifyRecord(finalRecord, manifest, unit, { completed: false }); }
          catch (verificationError) { attempt.state = 'unknown'; control.state = 'review-required'; control.lastError = verificationError.code; await save(); throw verificationError; }
          try {
            const recovered = await recoverFailedRecord(loaded, attempt, unit, finalRecord);
            if (recovered) {
              await exportUnit(workspace, registry, unit, recovered); completed.set(unit.source, recovered);
              attempt.state = 'completed'; await save();
              log(`${now()} Body ${completed.size}/${BODY_TOTAL}; request ${ordinal}/${NEW_ATTEMPT_LIMIT} ${unit.id}: local envelope recovery; original failure retained, zero extra calls.`);
            } else {
              attempt.state = 'failed'; control.state = 'review-required'; control.lastError = 'UNRECOVERABLE_FORMAT_FAILURE'; await save();
              log(`${now()} Request ${ordinal}/${NEW_ATTEMPT_LIMIT} ${unit.id}: ${attempt.errorCode}; exact target now unreachable within quota, stopped without retry.`);
              throw error;
            }
          } catch (recoveryError) {
            if (control.state !== 'review-required') {
              attempt.state = 'started'; control.state = 'review-required'; control.lastError = recoveryError.code ?? 'LOCAL_RECOVERY_FAILED'; await save();
            }
            throw recoveryError;
          }
        } else {
          attempt.state = finalRecord?.type === 'completed' ? 'started' : 'unknown';
          control.state = 'review-required'; control.lastError = attempt.errorCode; await save(); throw error;
        }
      } finally { await shardRelease(); }
    }
    await verifyExports(workspace, registry, completed);
    return finish();
  } finally {
    if (manageSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await release();
  }
}
export async function recoverChapterContinuation({ rootDir = PROJECT_ROOT } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  try {
    const loaded = await loadContinuation(rootDir), { control, runDir } = loaded;
    if (control.state !== 'review-required' || !['EXACT_TARGET_UNREACHABLE_WITH_REMAINING_QUOTA', 'UNRECOVERABLE_FORMAT_FAILURE'].includes(control.lastError)) {
      fail('RECOVERY_NOT_ALLOWED', 'Offline envelope recovery cannot clear unknown usage/identity or unrelated stops.');
    }
    const completed = await reconcile(rootDir, loaded);
    if (control.attempts.some(a => a.state !== 'completed') || completed.size + NEW_ATTEMPT_LIMIT - control.attempts.length !== BODY_TARGET) {
      fail('RECOVERY_INCOMPLETE', 'Some requests remain unresolved; preserve the stop.');
    }
    control.state = 'paused'; control.lastError = null; control.updatedAt = now();
    await atomicJson(ledgerPath(rootDir), control);
    await atomicJson(join(runDir, 'recovery-verification.json'), { passed: true, verifiedAt: now(),
      bodyCompleted: completed.size, newAttempts: control.attempts.length, maxNewRequests: NEW_ATTEMPT_LIMIT,
      remainingAuthorizedSlots: NEW_ATTEMPT_LIMIT - control.attempts.length, target: BODY_TARGET,
      recovered: control.attempts.filter(a => a.recoveryFile).map(a => ({ ordinal: a.ordinal, unitId: a.unitId,
        requestId: a.requestId, originalJournalFile: a.journalFile, recoveryFile: a.recoveryFile, kind: a.recoveryKind })),
      originalFailedJournalsPreserved: true, translatedTextChanged: false, newPaidRequests: 0 });
    return readChapterContinuationStatus({ rootDir });
  } finally { await release(); }
}
export async function buildChapterContinuation({ rootDir = PROJECT_ROOT } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  try {
    const loaded = await loadContinuation(rootDir);
    const { control, workspace, runDir, registry } = loaded;
    if (control.state === 'running') fail('CONTINUATION_ACTIVE', 'Stop translation before merge/build.');
    const completed = await reconcile(rootDir, loaded);
    const { mergeTranslations } = await import('../scripts/merge-translations.mjs');
    const { convertToTraditional } = await import('./chinese-conversion.mjs');
    const { build } = await import('../scripts/build.mjs');
    // Locale files may only be generated from the proven whole-body exports.
    const existing = await json(join(workspace, 'generated/locales/zh-Hans.json'), true);
    if (existing && Object.entries(existing).some(([s, t]) => completed.get(s) !== t)) fail('UNPROVEN_LOCALE', 'Existing locale contains unproven entries.');
    await mergeTranslations({ rootDir: workspace });
    await convertToTraditional({ rootDir: workspace });
    const status = await build({ projectRoot: workspace, allowPartial: true });
    const langs = await Promise.all(['zh-Hans', 'zh-Hant'].map(lang => json(join(workspace, `generated/locales/${lang}.json`))));
    if (langs.some(locale => Object.keys(locale).length !== completed.size || [...completed.keys()].some(s => !locale[s]))) fail('BUILD_COUNT_INVALID', 'Built locales differ from validated body count.');
    const evidence = { id: CONTINUATION_ID, builtAt: now(), bodyCompleted: completed.size, bodyTotal: BODY_TOTAL, target: BODY_TARGET,
      targetReached: completed.size === BODY_TARGET, uiCounted: 0, translatedMappings: registry.units.filter(u => completed.has(u.source)).length,
      partial: true, missingWholeBodyEnglishFallback: true, reportsCreated: false, status,
      previewDirectory: `${CONTINUATION_RUN}/workspace/dist`, state: control.state };
    await atomicJson(join(runDir, 'build-verification.json'), evidence);
    await atomicJson(join(runDir, 'quota-ledger.json'), control);
    return evidence;
  } finally { await release(); }
}
