#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  atomicJson, LANGUAGES, loadSource, PROJECT_ROOT, readLocale,
  translationStatus, validateShardWrapper,
} from './translate.mjs';

async function collectJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read shard directory ${directory}.`);
  }
  const files = [];
  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

export async function mergeTranslations({
  rootDir = PROJECT_ROOT,
  directory = join(rootDir, 'generated/shards'),
  log = console.log,
} = {}) {
  const { sourceHash, source } = await loadSource(rootDir);
  const files = await collectJsonFiles(directory);
  if (files.length === 0) throw new Error(`No JSON shard files found in ${directory}.`);
  const wrappers = [];
  // Finish validating every input before making any change to published locale files.
  for (const path of files) {
    let wrapper;
    try {
      wrapper = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error(`Cannot parse shard file ${path} as JSON.`);
    }
    validateShardWrapper(wrapper, { sourceHash, source }, path);
    wrappers.push({ path, wrapper });
  }

  const localePaths = Object.fromEntries(LANGUAGES.map((language) => [language, join(rootDir, 'generated/locales', `${language}.json`)]));
  const localeValues = Object.fromEntries(await Promise.all(LANGUAGES.map(async (language) => [
    language, await readLocale(localePaths[language], source),
  ])));
  let added = 0;
  for (const { path, wrapper } of wrappers) {
    const locale = localeValues[wrapper.language];
    for (const [text, translation] of Object.entries(wrapper.translations)) {
      if (Object.hasOwn(locale, text) && locale[text] !== translation) {
        const excerpt = JSON.stringify(text.length > 90 ? `${text.slice(0, 90)}…` : text);
        throw new Error(`Translation conflict for ${wrapper.language} source ${excerpt} in ${path}. Resolve the differing translations explicitly; no locale files were changed.`);
      }
      if (!Object.hasOwn(locale, text)) added += 1;
      locale[text] = translation;
    }
  }

  const status = translationStatus(sourceHash, source, localeValues);
  for (const language of LANGUAGES) await atomicJson(localePaths[language], localeValues[language]);
  await atomicJson(join(rootDir, 'generated/translation-status.json'), status);
  log(`Merged ${files.length} shard files; added ${added} translations for source snapshot ${sourceHash}.`);
  for (const language of LANGUAGES) {
    const coverage = status.languages[language];
    log(`${language}: ${coverage.translated}/${coverage.total} translated; ${coverage.complete ? 'COMPLETE' : 'PARTIAL'}.`);
  }
  if (!LANGUAGES.every((language) => status.languages[language].complete)) {
    log('The bilingual build is incomplete. Translate or collect the missing partitions, then merge again.');
  }
  return { files: files.length, added, status };
}

export function parseMergeArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  if (args.length > 1 || args[0]?.startsWith('-')) {
    throw new Error('Usage: node scripts/merge-translations.mjs [SHARD_DIRECTORY]');
  }
  return args.length ? { directory: resolve(args[0]) } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMergeArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/merge-translations.mjs [SHARD_DIRECTORY]\n\nDefault directory: generated/shards. All .json files are read recursively.\nRequires the same .cache/source/strings.json snapshot used by every shard.\nChecks source hashes, languages, shard partitions, nonempty translations, and conflicts before writing.\nWrites generated/locales/{zh-Hans,zh-Hant}.json and honest generated/translation-status.json coverage.\nNo API calls or API key are needed.');
    } else await mergeTranslations(options);
  } catch (error) {
    console.error(`Merge stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
