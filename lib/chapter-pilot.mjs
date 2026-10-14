import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicJson, PROJECT_ROOT, shardForText, validateShardWrapper } from '../scripts/translate.mjs';
import { acquireTranslationLock, createTranslationJournal, readTranslationKey } from './translation-journal.mjs';
import { createTranslator, CHAPTER_PROTOCOL, CHAPTER_PROMPT_TEMPLATE_HASH } from './translator.mjs';
import { createUnitCatalog, validateChapterTranslation } from './chapter-units.mjs';
import { TERMINOLOGY_HASH } from './terminology.mjs';

export const PILOT_IDS = Object.freeze(['alt02', 'met07', 'pop03', 'alt05', 'rnr03', 'met09', 'inl09', 'dtp', 'inl01', 'met']);
export const PILOT_ID = 'whole-chapter-pro-max-10-v1';
export const PILOT_RUN = 'artifacts/chapter-pilot/2026-10-14-pro-max-10';
export const BASELINE = 'artifacts/token-optimization/2026-10-13T14-12-30Z/baseline';
export const PILOT_CONFIG = Object.freeze({ language: 'zh-Hans', model: 'deepseek-v4-pro', reasoningEffort: 'max',
  thinking: 'enabled', maxTokens: 32768, timeoutMs: 600000, baseUrl: 'https://api.deepseek.com',
  unitProtocol: CHAPTER_PROTOCOL, shardCount: 8, concurrency: 1, maxAttempts: 10 });
const FROZEN_FILES = ['lib/chapter-pilot.mjs', 'lib/chapter-units.mjs', 'lib/translator.mjs', 'lib/translation-journal.mjs',
  'lib/translation-retirement.mjs', 'lib/terminology.mjs', 'lib/benchmark-cost.mjs', 'lib/chinese-conversion.mjs',
  'scripts/translate.mjs', 'scripts/production.mjs', 'scripts/merge-translations.mjs', 'scripts/convert.mjs',
  'scripts/build.mjs', 'scripts/sync-source.mjs', 'public/chapter-renderer.js', 'public/overlay.js', 'public/overlay.css',
  'public/dictionary.js', 'data/terminology.json', 'benchmarks/pricing.json', 'package-lock.json'];
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const controlPath = root => join(root, 'generated/production/chapter-pilot.json');
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
async function json(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function hashes(root, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async file => [file, hash(await readFile(join(root, file)))])));
}
async function treeFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) fail('UNSAFE_SOURCE', 'Source snapshot may not contain symlinks.');
    if (entry.isDirectory()) files.push(...await treeFiles(root, name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}
function validateControl(control) {
  if (!control || control.id !== PILOT_ID || control.run !== PILOT_RUN || !Array.isArray(control.attempts)
    || control.attempts.length > 10 || control.maxAttempts !== 10
    || control.attempts.some((a, i) => a.ordinal !== i + 1 || a.chapterId !== PILOT_IDS[i])) {
    fail('PILOT_LEDGER_INVALID', 'The shared ten-attempt ledger is invalid. No requests may be sent.');
  }
}

export async function prepareChapterPilot({ rootDir = PROJECT_ROOT } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  try {
    const existing = await json(controlPath(rootDir), true);
    if (existing) { await loadPilot({ rootDir }); return readChapterPilotStatus({ rootDir }); }
    const retired = await json(join(rootDir, 'generated/production/retired.json'));
    if (!retired.archive || retired.baseline !== BASELINE) fail('ARCHIVE_REQUIRED', 'A verified archive and the pre-optimization baseline are required.');
    const archiveManifest = join(rootDir, retired.archive, 'manifest.json');
    const archived = await json(archiveManifest);
    if (archived.marker !== 'v1-fragments-retired') fail('ARCHIVE_REQUIRED', 'Unexpected archive marker.');
    const baselineDir = join(rootDir, BASELINE);
    const baseline = await json(join(baselineDir, 'manifest.json'));
    if (baseline.gitCommit !== '8e7eb67c5034d0e7a7b0d6f6044de23cb3b93a89' || baseline.status.translated !== 5809
      || baseline.config.maxTokens !== 32768 || baseline.config.reasoningEffort !== 'max') fail('BASELINE_MISMATCH', 'The original baseline settings differ.');
    // The pre-optimization snapshot saved the two textual source files. The original
    // asset manifest verifies the remaining untouched site assets from the full archive.
    const sourceDir = join(rootDir, retired.archive, 'files/generated/site');
    const siteManifest = await json(join(rootDir, retired.archive, 'files/generated/source-manifest.json'));
    if (siteManifest.stringsSha256 !== baseline.files['.cache/source/strings.json']) fail('BASELINE_CHANGED', 'The asset manifest is not from the baseline source snapshot.');
    const resourceHashes = Object.fromEntries(siteManifest.resources.map(entry => [entry.path, entry.sha256]));
    const sourceFiles = await treeFiles(sourceDir);
    for (const file of sourceFiles) {
      const actual = hash(await readFile(join(sourceDir, file)));
      if (actual !== resourceHashes[file] || actual !== archived.files[`generated/site/${file}`]?.sha256
        || (baseline.files[`generated/site/${file}`] && actual !== baseline.files[`generated/site/${file}`])) fail('BASELINE_CHANGED', `Saved source differs: ${file}`);
    }
    if (sourceFiles.length !== siteManifest.resources.length) fail('BASELINE_CHANGED', 'The source asset set changed.');
    const runDir = join(rootDir, PILOT_RUN);
    if (await stat(runDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) fail('PILOT_ALREADY_EXISTS', 'Pilot files already exist without a control ledger. Review the interrupted preparation; do not reset its budget.');
    const catalog = createUnitCatalog({ html: await readFile(join(sourceDir, 'index.html'), 'utf8'),
      genres: await json(join(sourceDir, 'master-genrelist.json')), bundle: await readFile(join(sourceDir, 'main.bundle.js'), 'utf8') });
    const selected = PILOT_IDS.map(id => {
      const unit = catalog.units.find(unit => unit.genreId === id || unit.id === id);
      if (!unit) fail('PILOT_CHAPTER_MISSING', `Selected chapter ${id} is absent.`);
      validateChapterTranslation(unit.source, unit.source);
      if (unit.source.length > 5000) fail('CHAPTER_TOO_LONG', `Complete chapter ${id} exceeds the unchanged input limit.`);
      return { chapterId: id, unitId: unit.id, sourceHash: hash(unit.source), shard: shardForText(unit.source, 8),
        paragraphs: unit.paragraphs.length, characters: unit.source.length };
    });
    const workspace = join(runDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    await cp(sourceDir, join(workspace, 'generated/site'), { recursive: true });
    for (const folder of ['lib', 'scripts', 'public', 'data', 'benchmarks', 'test']) await cp(join(rootDir, folder), join(workspace, folder), { recursive: true });
    for (const file of ['package.json', 'package-lock.json', 'server.mjs']) await cp(join(rootDir, file), join(workspace, file));
    await atomicJson(join(workspace, '.cache/source/strings.json'), catalog.source);
    await atomicJson(join(workspace, '.cache/source/units.json'), catalog);
    await atomicJson(join(workspace, 'generated/production/chapter-pilot-policy.json'), { id: PILOT_ID, control: relative(workspace, controlPath(rootDir)), maxAttempts: 10 });
    for (let index = 1; index <= 8; index++) await atomicJson(join(workspace, `generated/shards/zh-Hans-${index}-of-8.json`),
      { sourceHash: hash(JSON.stringify(catalog.source)), language: 'zh-Hans', shard: { index, count: 8 }, translations: {} });
    const program = await hashes(rootDir, FROZEN_FILES);
    const inputs = await hashes(workspace, ['.cache/source/strings.json', '.cache/source/units.json', ...sourceFiles.map(file => `generated/site/${file}`)]);
    const manifest = { schemaVersion: 1, id: PILOT_ID, createdAt: now(), config: PILOT_CONFIG,
      baseline: BASELINE, baselineManifestHash: hash(await readFile(join(baselineDir, 'manifest.json'))),
      baselineGitCommit: baseline.gitCommit, archive: retired.archive, archiveManifestHash: hash(await readFile(archiveManifest)),
      authSourceFile: join(homedir(), '.ssh/musicmap_trans'), sourceHash: hash(JSON.stringify(catalog.source)),
      catalogHash: hash(JSON.stringify(catalog)), selected, program, inputs, terminologyHash: TERMINOLOGY_HASH,
      promptTemplateHash: CHAPTER_PROMPT_TEMPLATE_HASH, adoption: 'trial-only-awaiting-review' };
    await atomicJson(join(runDir, 'manifest.json'), manifest);
    await atomicJson(controlPath(rootDir), { schemaVersion: 1, id: PILOT_ID, run: PILOT_RUN,
      manifestHash: hash(await readFile(join(runDir, 'manifest.json'))), maxAttempts: 10,
      state: 'prepared', createdAt: now(), attempts: [] });
    return readChapterPilotStatus({ rootDir });
  } finally { await release(); }
}

async function loadPilot({ rootDir = PROJECT_ROOT, verifyFiles = true } = {}) {
  const control = await json(controlPath(rootDir)); validateControl(control);
  const runDir = join(rootDir, control.run); const workspace = join(runDir, 'workspace');
  const manifestBytes = await readFile(join(runDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (hash(manifestBytes) !== control.manifestHash || JSON.stringify(manifest.config) !== JSON.stringify(PILOT_CONFIG)
    || manifest.promptTemplateHash !== CHAPTER_PROMPT_TEMPLATE_HASH || manifest.terminologyHash !== TERMINOLOGY_HASH
    || JSON.stringify(manifest.selected.map(x => x.chapterId)) !== JSON.stringify(PILOT_IDS)) {
    fail('PILOT_MANIFEST_CHANGED', 'The frozen pilot identity/settings changed.');
  }
  if (verifyFiles) {
    if (JSON.stringify(await hashes(rootDir, Object.keys(manifest.program))) !== JSON.stringify(manifest.program)
      || JSON.stringify(await hashes(workspace, Object.keys(manifest.program))) !== JSON.stringify(manifest.program)
      || JSON.stringify(await hashes(workspace, Object.keys(manifest.inputs))) !== JSON.stringify(manifest.inputs)) {
      fail('PILOT_FROZEN_INPUT_CHANGED', 'A frozen program, source, registry, prompt, or pricing input changed.');
    }
  }
  const registry = await json(join(workspace, '.cache/source/units.json'));
  if (hash(JSON.stringify(registry)) !== manifest.catalogHash) fail('PILOT_REGISTRY_CHANGED', 'The frozen chapter registry changed.');
  const units = manifest.selected.map(selected => {
    const unit = registry.units.find(u => u.id === selected.unitId);
    if (!unit || hash(unit.source) !== selected.sourceHash) fail('PILOT_UNIT_CHANGED', 'A selected complete chapter changed.');
    return unit;
  });
  return { control, manifest, registry, units, runDir, workspace };
}

export async function readChapterPilotStatus({ rootDir = PROJECT_ROOT } = {}) {
  const control = await json(controlPath(rootDir), true);
  if (!control) return { state: 'not-prepared', maxAttempts: 10 };
  validateControl(control);
  return { id: control.id, state: control.state, attempts: control.attempts.length, maxAttempts: 10,
    completed: control.attempts.filter(a => a.state === 'completed').length,
    failed: control.attempts.filter(a => a.state === 'failed').length,
    uncertain: control.attempts.filter(a => ['reserved', 'started', 'unknown'].includes(a.state)).length,
    run: control.run, lastError: control.lastError ?? null, adopted: false };
}

async function exportChapter(workspace, registry, unit, translation) {
  validateChapterTranslation(unit.source, translation);
  const sourceHash = hash(JSON.stringify(registry.source));
  const index = shardForText(unit.source, 8);
  const path = join(workspace, `generated/shards/zh-Hans-${index}-of-8.json`);
  const wrapper = await json(path);
  validateShardWrapper(wrapper, { sourceHash, source: registry.source, shard: { index, count: 8 } });
  const previous = wrapper.translations[unit.source];
  if (previous !== undefined && previous !== translation) fail('PILOT_EXPORT_CONFLICT', 'An exported chapter differs from its paid journal.');
  wrapper.translations[unit.source] = translation;
  await atomicJson(path, wrapper);
}

/** The queue has one durable quota across all eight shards. Failed and uncertain attempts consume slots. */
export async function executeChapterPilot({ rootDir = PROJECT_ROOT, fetchImpl = globalThis.fetch, apiKey,
  manageSignals = true, shouldStop = () => false, log = console.log, afterJournal = async () => {} } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  let stopping = false;
  const stop = () => { stopping = true; log('Stop requested: finish the in-flight chapter, then stop.'); };
  if (manageSignals) { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  try {
    const { control, manifest, registry, units, runDir, workspace } = await loadPilot({ rootDir });
    const save = async () => { control.updatedAt = now(); await atomicJson(controlPath(rootDir), control); };
    // Replay only completed, identity-matched journals. Never rebuy an uncertain request.
    for (const attempt of control.attempts) {
      const record = attempt.journalFile ? await json(join(workspace, attempt.journalFile), true) : null;
      const unit = units[attempt.ordinal - 1];
      if (record?.type === 'completed') {
        verifyRecord(record, manifest, unit);
        await exportChapter(workspace, registry, unit, record.translations[0]);
        attempt.state = 'completed'; attempt.requestId = record.requestId;
      } else if (record?.type === 'failed' && knownUsage(record)) {
        attempt.state = 'failed'; attempt.errorCode = record.errorCode;
      } else if (['reserved', 'started', 'unknown'].includes(attempt.state)) {
        attempt.state = 'unknown'; control.state = 'review-required'; control.lastError = 'UNRESOLVED_ATTEMPT';
        await save(); fail('UNRESOLVED_ATTEMPT', 'A reserved or started request has no final known-usage journal. No further request will be sent.');
      }
    }
    await save();
    if (control.state === 'review-required') fail(control.lastError ?? 'REVIEW_REQUIRED', 'The pilot stopped for review; no automatic retry is allowed.');
    if (control.attempts.length >= 10) { control.state = 'awaiting-review'; await save(); return readChapterPilotStatus({ rootDir }); }
    const key = await readTranslationKey({ apiKey, apiKeyFile: apiKey === undefined ? manifest.authSourceFile : undefined });
    if (!key) fail('API_KEY_MISSING', 'The pilot API key is missing.');
    control.state = 'running'; await save();
    while (control.attempts.length < 10 && !stopping && !shouldStop()) {
      const ordinal = control.attempts.length + 1;
      const selected = manifest.selected[ordinal - 1]; const unit = units[ordinal - 1];
      const scope = `chapter-${ordinal}-${selected.chapterId}`;
      const identity = { pilot: PILOT_ID, sourceHash: manifest.sourceHash, catalogHash: manifest.catalogHash,
        chapterId: selected.chapterId, model: PILOT_CONFIG.model, reasoningEffort: 'max', maxTokens: 32768,
        promptTemplateHash: CHAPTER_PROMPT_TEMPLATE_HASH, terminologyHash: TERMINOLOGY_HASH };
      const journal = await createTranslationJournal({ rootDir: workspace, scope, identity, source: [unit.source] });
      if (Object.keys(journal.recovered).length) fail('UNRESERVED_JOURNAL', 'An unreserved paid journal exists. Review before spending another slot.');
      const attempt = { ordinal, chapterId: selected.chapterId, unitId: unit.id, sourceHash: selected.sourceHash,
        shard: selected.shard, state: 'reserved', reservedAt: now(), requestId: null, journalFile: null };
      control.attempts.push(attempt); await save(); // durable reservation precedes the potentially billable call
      const shardRelease = await acquireTranslationLock(workspace, `zh-Hans-${selected.shard}-of-8`);
      let finalRecord = null;
      try {
        const translator = createTranslator({ apiKey: key, ...PILOT_CONFIG,
          cacheDir: join(workspace, '.cache/translations'), fetchImpl,
          shouldStop: () => stopping || shouldStop(),
          onRequest: async event => {
            if (event.type === 'started') {
              if (attempt.requestId !== null) fail('PILOT_REQUEST_LIMIT', 'A reserved slot may send only one request.');
              attempt.requestId = event.requestId;
              attempt.journalFile = `generated/translation-requests/${scope}/${event.requestId}.json`;
              attempt.state = 'started'; await save();
            }
            await journal.record(event);
            if (event.type !== 'started') finalRecord = await json(join(workspace, attempt.journalFile));
          } });
        const context = `Complete chapter: ${unit.title}. Genre code: ${selected.chapterId}. Registry: ${manifest.catalogHash}.`;
        const result = await translator.translate({ language: 'zh-Hans', texts: [unit.source], contexts: [context] });
        if (!finalRecord || result.cached) fail('UNEXPECTED_CACHE_HIT', 'A fresh pilot chapter must have its own recorded paid request.');
        verifyRecord(finalRecord, manifest, unit);
        await afterJournal({ ordinal, record: finalRecord });
        await exportChapter(workspace, registry, unit, result.translations[0]);
        attempt.state = 'completed'; attempt.finishedAt = now(); await save();
        log(`Chapter ${ordinal}/10 ${selected.chapterId}: complete; ${finalRecord.normalizedUsage?.total ?? 'unknown'} tokens.`);
      } catch (error) {
        attempt.errorCode = error.code ?? 'LOCAL_OPERATION_FAILED'; attempt.finishedAt = now();
        if (error.code === 'STOP_REQUESTED_BEFORE_SEND' && finalRecord?.requestSent === false) {
          attempt.state = 'not-sent'; control.state = 'paused'; await save(); break;
        } else if (finalRecord?.type === 'failed' && knownUsage(finalRecord)
          && ['INVALID_TRANSLATION', 'INVALID_CHAPTER_STRUCTURE', 'INCOMPLETE_TRANSLATION'].includes(finalRecord.errorCode)) {
          attempt.state = 'failed'; await save();
          log(`Chapter ${ordinal}/10 ${selected.chapterId}: rejected (${attempt.errorCode}); slot spent, no retry.`);
        } else {
          // A completed journal is preserved for cost-free recovery; do not replace it with a failure.
          attempt.state = finalRecord?.type === 'completed' ? 'started' : 'unknown';
          control.state = 'review-required'; control.lastError = attempt.errorCode; await save(); throw error;
        }
      } finally { await shardRelease(); }
    }
    control.state = control.attempts.length === 10 ? 'awaiting-review' : 'paused'; await save();
    await atomicJson(join(runDir, 'stop-marker.json'), { id: PILOT_ID, stoppedAt: now(), state: control.state,
      attempts: control.attempts.length, limit: 10, adopted: false, published: false });
    return readChapterPilotStatus({ rootDir });
  } finally {
    if (manageSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await release();
  }
}
function knownUsage(record) { return Number.isSafeInteger(record.rawUsage?.prompt_tokens) && Number.isSafeInteger(record.rawUsage?.completion_tokens); }
function verifyRecord(record, manifest, unit) {
  if (record.type !== 'completed' || record.model !== PILOT_CONFIG.model || record.returnedModel !== PILOT_CONFIG.model
    || record.reasoningEffort !== 'max' || record.maxTokens !== 32768 || !knownUsage(record)
    || record.identity?.pilot !== PILOT_ID || record.identity?.catalogHash !== manifest.catalogHash
    || record.identity?.sourceHash !== manifest.sourceHash || record.promptTemplateHash !== CHAPTER_PROMPT_TEMPLATE_HASH
    || record.textHashes?.length !== 1 || record.textHashes[0] !== hash(unit.source) || record.translations?.length !== 1) {
    fail('PILOT_JOURNAL_MISMATCH', 'Paid chapter journal does not match its frozen source and settings.');
  }
  validateChapterTranslation(unit.source, record.translations[0]);
}

export async function reportChapterPilot({ rootDir = PROJECT_ROOT } = {}) {
  const release = await acquireTranslationLock(rootDir, 'chapter-pilot-control');
  try {
    const { control, manifest, registry, units, runDir, workspace } = await loadPilot({ rootDir, verifyFiles: false });
    if (control.state === 'running') fail('PILOT_ACTIVE', 'Wait for the current pilot process to stop before reporting.');
    const attempts = await Promise.all(control.attempts.map(async (attempt, i) => {
      const record = attempt.journalFile ? await json(join(workspace, attempt.journalFile), true) : null;
      return { ...attempt, source: units[i].source, translation: record?.type === 'completed' ? record.translations[0] : undefined,
        responseText: record?.responseText, requestSent: record?.requestSent, rawUsage: record?.rawUsage ?? null, usage: record?.normalizedUsage ?? null,
        cost: record?.cost ?? null, latencyMs: record?.latencyMs ?? null, errorCode: record?.errorCode ?? attempt.errorCode,
        startedAt: record?.startedAt, finishedAt: record?.finishedAt, journalFile: attempt.journalFile ? `workspace/${attempt.journalFile}` : null };
    }));
    const { mergeTranslations } = await import('../scripts/merge-translations.mjs');
    const { convertToTraditional } = await import('./chinese-conversion.mjs');
    const { build } = await import('../scripts/build.mjs');
    await mergeTranslations({ rootDir: workspace });
    await convertToTraditional({ rootDir: workspace });
    await build({ projectRoot: workspace, allowPartial: true });
    const { renderChapterReport } = await import('./chapter-report.mjs');
    const report = await renderChapterReport({ runDir, baselineDir: join(rootDir, BASELINE, 'files'), registry, attempts,
      config: { ...manifest.config, selectedChapterIds: [...PILOT_IDS], baselineExpectedCount: 5809,
        baseline: BASELINE, baselineGitCommit: manifest.baselineGitCommit, archive: manifest.archive, state: control.state } });
    await atomicJson(join(runDir, 'attempts.json'), attempts);
    return { state: control.state, attempts: attempts.length, report: report ?? 'report.html', partialBuild: `${PILOT_RUN}/workspace/dist`, adopted: false };
  } finally { await release(); }
}

export async function chapterPilotCommand(mode, options = {}) {
  if (mode === 'prepare') return prepareChapterPilot(options);
  if (mode === 'execute') return executeChapterPilot(options);
  if (mode === 'report') return reportChapterPilot(options);
  return readChapterPilotStatus(options);
}
