import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { calculateCost, normalizeUsage } from './benchmark-cost.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export async function readTranslationKey({ apiKey, apiKeyFile } = {}) {
  if (!apiKeyFile) return apiKey;
  const file = apiKeyFile.startsWith('~/') ? join(homedir(), apiKeyFile.slice(2)) : resolve(apiKeyFile);
  let key;
  try { key = (await readFile(file, 'utf8')).trim(); }
  catch { throw new Error('Cannot read DEEPSEEK_API_KEY_FILE.'); }
  if (!/^sk-[a-zA-Z0-9_-]+$/.test(key)) throw new Error('DEEPSEEK_API_KEY_FILE must contain only the DeepSeek API key.');
  return key;
}

async function save(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function acquireTranslationLock(rootDir, scope) {
  const directory = join(rootDir, 'generated/translation-locks', scope);
  await mkdir(dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Translation lock exists for ${scope}; inspect the recorded process before removing a stale lock.`);
    throw error;
  }
  try { await save(join(directory, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return () => rm(directory, { recursive: true, force: true });
}

export async function createTranslationJournal({ rootDir, scope, identity, source, retryFailed = false }) {
  const directory = join(rootDir, 'generated/translation-requests', scope);
  const identityHash = hash(JSON.stringify(identity));
  let filenames;
  try { filenames = (await readdir(directory)).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; filenames = []; }
  const records = await Promise.all(filenames.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  const reviewed = new Set(records.flatMap(record => record.reviewedPreviousRequestIds ?? []));
  const unresolved = records.filter(record => (record.type === 'started' || record.type === 'failed') && !reviewed.has(record.requestId));
  if (unresolved.length && !retryFailed) {
    throw new Error(`${unresolved.length} failed or interrupted API request(s) require review in ${directory}; --retry-failed explicitly permits a new paid attempt. Existing records are preserved.`);
  }
  const sources = new Map(source.map(text => [hash(text), text]));
  const recovered = Object.create(null);
  for (const record of records) {
    if (record.type !== 'completed' || record.identityHash !== identityHash || !Array.isArray(record.translations)) continue;
    if (!Array.isArray(record.textHashes) || record.textHashes.length !== record.translations.length) throw new Error('Invalid completed translation journal record.');
    record.textHashes.forEach((textHash, index) => {
      const text = sources.get(textHash);
      const translation = record.translations[index];
      if (text === undefined || typeof translation !== 'string' || (text.trim() && !translation.trim())) throw new Error('Translation journal does not match the current source.');
      if (Object.hasOwn(recovered, text) && recovered[text] !== translation) throw new Error('Conflicting paid translations in request journal; review before resuming.');
      recovered[text] = translation;
    });
  }
  let pricing;
  try { pricing = JSON.parse(await readFile(join(rootDir, 'benchmarks/pricing.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    recovered,
    async record(event) {
      if (!/^[a-f0-9-]{36}$/.test(event.requestId)) throw new Error('Invalid request journal identifier.');
      const normalizedUsage = normalizeUsage('deepseek', event.rawUsage);
      let cost = null;
      let costNote = null;
      if (normalizedUsage && pricing) {
        try { cost = calculateCost({ provider: 'deepseek', model: event.model, usage: normalizedUsage,
          startedAt: event.startedAt, finishedAt: event.finishedAt, pricing }); }
        catch { costNote = 'Usage retained; verify current official pricing and calendar before calculating cost.'; }
      }
      await save(join(directory, `${event.requestId}.json`), {
        ...event, identityHash, identity, normalizedUsage, cost, costNote,
        ...(retryFailed && unresolved.length ? { reviewedPreviousRequestIds: unresolved.map(record => record.requestId) } : {}),
      });
    },
  };
}
