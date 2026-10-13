#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTranslator } from '../lib/translator.mjs';
import { dictionary } from '../public/dictionary.js';
import { TERMINOLOGY } from '../lib/terminology.mjs';

export const LANGUAGES = ['zh-Hans', 'zh-Hant'];
export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const words = new Map(Object.entries(dictionary).map(([text, value]) => [normalize(text), value]));
const preferredTerms = new Map(TERMINOLOGY.terms.flatMap((term) => term.english.map((alias) => [normalize(alias), term.simplified])));

function validTranslation(value, source) {
  return typeof value === 'string' && (source.trim().length === 0 || value.trim().length > 0);
}

export async function readLocale(path, source) {
  let existing;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw new Error(`Cannot read locale file ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : 'file is not readable'}.`);
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`Locale file ${path} must contain an object of source text to translated text.`);
  }
  const output = Object.create(null);
  for (const text of source) {
    if (Object.hasOwn(existing, text) && validTranslation(existing[text], text)) output[text] = existing[text];
  }
  return output;
}

export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadSource(rootDir) {
  const sourcePath = join(rootDir, '.cache/source/strings.json');
  let original;
  try {
    original = JSON.parse(await readFile(sourcePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Source strings are missing at ${sourcePath}. Run source extraction first.`);
    throw new Error(`Cannot read source strings at ${sourcePath}. Expected a JSON array of strings.`);
  }
  if (!Array.isArray(original)) throw new Error('Source strings must be a JSON array.');
  for (let index = 0; index < original.length; index += 1) {
    if (typeof original[index] !== 'string' || original[index].length > 5000) {
      throw new Error(`Source string at index ${index} must be a string of at most 5000 characters. Split long text during extraction.`);
    }
  }
  return {
    sourceHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    source: [...new Set(original)],
  };
}

export function validateShard(shard) {
  if (
    !shard || typeof shard !== 'object' ||
    !Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.count) ||
    shard.count < 1 || shard.index < 1 || shard.index > shard.count
  ) throw new Error('Shard must be INDEX/COUNT with integer values 1 <= INDEX <= COUNT.');
  return { index: shard.index, count: shard.count };
}

export function shardForText(text, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer.');
  const hash = createHash('sha256').update(text).digest('hex');
  return Number(BigInt(`0x${hash}`) % BigInt(count)) + 1;
}

export function validateShardWrapper(wrapper, { sourceHash, source, language, shard } = {}, label = 'Shard file') {
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) throw new Error(`${label}: expected a shard object.`);
  if (wrapper.sourceHash !== sourceHash) throw new Error(`${label}: sourceHash does not match the current source snapshot.`);
  if (wrapper.language === 'zh-Hant') {
    throw new Error(`${label}: Traditional Chinese shards are not accepted. Translate zh-Hans only, then use npm run convert to generate zh-Hant locally with OpenCC.`);
  }
  if (wrapper.language !== 'zh-Hans' || (language && wrapper.language !== language)) {
    throw new Error(`${label}: invalid or unexpected language.`);
  }
  const declared = validateShard(wrapper.shard);
  if (shard && (declared.index !== shard.index || declared.count !== shard.count)) {
    throw new Error(`${label}: shard metadata does not match the requested partition.`);
  }
  if (!wrapper.translations || typeof wrapper.translations !== 'object' || Array.isArray(wrapper.translations)) {
    throw new Error(`${label}: translations must be an object.`);
  }
  const known = new Set(source);
  for (const [text, translation] of Object.entries(wrapper.translations)) {
    if (!known.has(text)) throw new Error(`${label}: contains a source text absent from the current snapshot.`);
    if (shardForText(text, declared.count) !== declared.index) throw new Error(`${label}: contains text outside its declared partition.`);
    if (typeof translation !== 'string' || translation.trim().length === 0) {
      throw new Error(`${label}: every translation must be a nonempty string.`);
    }
  }
  return wrapper;
}

async function readShard(path, options) {
  let wrapper;
  try {
    wrapper = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw new Error(`Cannot read shard file ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : 'file is not readable'}.`);
  }
  validateShardWrapper(wrapper, options, path);
  return Object.assign(Object.create(null), wrapper.translations);
}

export function translationStatus(sourceHash, source, localeValues) {
  const total = source.length;
  return {
    sourceHash,
    total,
    languages: Object.fromEntries(LANGUAGES.map((language) => {
      const translated = source.filter((text) => Object.hasOwn(localeValues[language], text)).length;
      return [language, {
        translated, total, complete: translated === total,
        ...(language === 'zh-Hant' ? { derived: true } : {}),
      }];
    })),
  };
}

export function makeBatches(texts, { maxTexts = 20, maxCharacters = 14_000 } = {}) {
  const batches = [];
  let batch = [];
  let characters = 0;
  for (const text of texts) {
    if (text.length > maxCharacters) throw new Error('A source text exceeds the batch character limit.');
    if (batch.length > 0 && (batch.length >= maxTexts || characters + text.length > maxCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(text);
    characters += text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function runTranslation({
  rootDir = PROJECT_ROOT,
  languages = ['zh-Hans'],
  limit = Infinity,
  dryRun = false,
  shard: requestedShard,
  apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model = process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (Array.isArray(languages) && languages.includes('zh-Hant')) {
    throw new Error('Traditional Chinese is generated locally with OpenCC. Use npm run convert; DeepSeek translation is only available for zh-Hans.');
  }
  if (!Array.isArray(languages) || languages.length === 0 || languages.some((language) => language !== 'zh-Hans')) {
    throw new Error('language must be zh-Hans. Use npm run convert to generate zh-Hant locally.');
  }
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('limit must be a nonnegative integer.');
  }
  const selected = [...new Set(languages)];
  const shard = requestedShard === undefined ? null : validateShard(requestedShard);
  const { sourceHash, source: entireSource } = await loadSource(rootDir);
  const source = shard ? entireSource.filter((text) => shardForText(text, shard.count) === shard.index) : entireSource;
  const total = source.length;
  if (shard) log(`Shard ${shard.index}/${shard.count}: assigned ${total}/${entireSource.length} source texts; snapshot ${sourceHash}.`);
  const localePaths = Object.fromEntries(LANGUAGES.map((language) => [language, shard && language === 'zh-Hans'
    ? join(rootDir, 'generated/shards', `${language}-${shard.index}-of-${shard.count}.json`)
    : join(rootDir, 'generated/locales', `${language}.json`),
  ]));
  const localeValues = Object.fromEntries(await Promise.all(LANGUAGES.map(async (language) => [
    language, shard && language === 'zh-Hans'
      ? await readShard(localePaths[language], { sourceHash, source: entireSource, language, shard })
      : await readLocale(localePaths[language], source),
  ])));
  const estimates = {};
  for (const language of selected) {
    const locale = localeValues[language];
    for (const text of source) {
      const manual = preferredTerms.get(normalize(text)) ?? words.get(normalize(text))?.[0];
      if (!Object.hasOwn(locale, text)) {
        if (manual !== undefined) locale[text] = manual;
        else if (text.trim().length === 0) locale[text] = text;
      }
    }
    const missing = source.filter((text) => !Object.hasOwn(locale, text));
    estimates[language] = { missing: missing.length, characters: missing.reduce((sum, text) => sum + text.length, 0) };
    log(`${language}: ${total - missing.length}/${total} available; ${missing.length} missing texts, ${estimates[language].characters} source characters.`);
  }
  if (limit !== Infinity) log(`Limit: at most ${limit} additional text translations across all selected languages; dictionary entries do not count.`);
  log('Existing disk cache is reused before making API requests. Estimates include texts not yet exported to locale files.');

  function currentStatus() {
    const status = translationStatus(sourceHash, source, localeValues);
    return shard ? { ...status, shard, corpusTotal: entireSource.length } : status;
  }
  if (dryRun) {
    log('DRY RUN: no API calls or output files were written.');
    return { dryRun: true, estimates, status: currentStatus(), processed: 0 };
  }

  const statusPath = join(rootDir, 'generated/translation-status.json');
  async function saveLocale(language) {
    await atomicJson(localePaths[language], shard
      ? { sourceHash, language, shard, translations: localeValues[language] }
      : localeValues[language]);
  }
  // Save dictionary coverage first; missing credentials or a later failed batch must not imply completeness.
  for (const language of selected) await saveLocale(language);
  if (!shard) await atomicJson(statusPath, currentStatus());
  const translator = createTranslator({
    apiKey,
    baseUrl,
    model,
    cacheDir: join(rootDir, '.cache/translations'),
    fetchImpl,
  });
  let processed = 0;
  for (const language of selected) {
    const locale = localeValues[language];
    const missing = source.filter((text) => !Object.hasOwn(locale, text));
    const remaining = limit === Infinity ? missing : missing.slice(0, Math.max(0, limit - processed));
    for (const texts of makeBatches(remaining)) {
      const result = await translator.translate({ texts, language });
      for (let index = 0; index < texts.length; index += 1) locale[texts[index]] = result.translations[index];
      processed += texts.length;
      await saveLocale(language);
      if (!shard) await atomicJson(statusPath, currentStatus());
      log(`${language}: ${currentStatus().languages[language].translated}/${total} exported (${result.cached}/${texts.length} reused from cache).`);
    }
  }
  const status = currentStatus();
  const complete = status.languages['zh-Hans'].complete;
  const scope = shard ? `zh-Hans shard ${shard.index}/${shard.count}` : 'zh-Hans';
  log(complete
    ? `COMPLETE for ${scope}: all ${total} assigned source texts are translated.${shard ? ' Merge the Simplified Chinese shards, then run npm run convert to generate Traditional Chinese locally.' : ' Run npm run convert to generate or refresh Traditional Chinese locally; no API calls are needed.'}`
    : `PARTIAL for ${scope}: ${status.languages['zh-Hans'].translated}/${total}. Run this command again to finish missing Simplified Chinese translations, then use npm run convert.`);
  return { dryRun: false, estimates, status, processed };
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--language' || argument.startsWith('--language=')) {
      const language = argument.includes('=') ? argument.slice('--language='.length) : args[++index];
      if (language === 'zh-Hant') throw new Error('Do not translate zh-Hant with DeepSeek. Use npm run convert to generate Traditional Chinese locally with OpenCC.');
      if (language !== 'zh-Hans') throw new Error('--language must be zh-Hans. Use npm run convert for zh-Hant.');
      options.languages = [language];
    } else if (argument === '--limit' || argument.startsWith('--limit=')) {
      const value = argument.includes('=') ? argument.slice('--limit='.length) : args[++index];
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--limit must be a nonnegative integer.');
      }
      options.limit = Number(value);
    } else if (argument === '--shard' || argument.startsWith('--shard=')) {
      const value = argument.includes('=') ? argument.slice('--shard='.length) : args[++index];
      if (!/^\d+\/\d+$/.test(value ?? '')) throw new Error('--shard must use the form INDEX/COUNT, for example 1/3.');
      const [shardIndex, count] = value.split('/').map(Number);
      options.shard = validateShard({ index: shardIndex, count });
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node --env-file-if-exists=.env scripts/translate.mjs [--language zh-Hans] [--limit N] [--shard INDEX/COUNT] [--dry-run]\n\nTranslates Simplified Chinese only into generated/locales/zh-Hans.json.\nTraditional Chinese is derived locally with OpenCC: npm run convert. --language zh-Hant is rejected.\n--limit counts newly exported source texts, including cache hits; dictionary entries do not count.\n--shard 1/3 assigns SHA256(text) modulo 3 + 1 = 1 and writes only generated/shards/zh-Hans-1-of-3.json.\nAll machines must use the same source snapshot and shard count. Copy shard files together and run scripts/merge-translations.mjs.\nSet DEEPSEEK_API_KEY only on the machine running this build command.\n--dry-run estimates missing text without writing files or making API calls.');
    } else await runTranslation(options);
  } catch (error) {
    console.error(`Translation stopped${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
    console.error('Existing exports retain completed batches only. Shard runs never update global locale files or translation-status.json; run the merge command to recompute global coverage.');
    process.exitCode = 1;
  }
}
