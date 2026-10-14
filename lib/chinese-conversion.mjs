import * as OpenCC from 'opencc-js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTraditionalTerminology, relevantTerms, TERMINOLOGY_HASH } from './terminology.mjs';
import { dictionary } from '../public/dictionary.js';
import { isChapterSource, parseChapterTranslation, serializeChapterAst, stripChapterMarkers, validateChapterTranslation, readUnitCatalog } from './chapter-units.mjs';

export const CONVERTER = Object.freeze({ name: 'opencc-js', version: '1.4.2', from: 'cn', to: 'tw' });
const convert = OpenCC.Converter({ from: CONVERTER.from, to: CONVERTER.to });
const root = fileURLToPath(new URL('..', import.meta.url));
const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
const interfaceLabels = new Map(Object.entries(dictionary).map(([source, pair]) => [normalize(source), pair]));
export const sourceHash = strings => createHash('sha256').update(JSON.stringify(strings)).digest('hex');
export const hashLocale = locale => sourceHash(Object.fromEntries(Object.keys(locale).sort().map(key => [key, locale[key]])));

export function convertText(original, simplified) {
  if (isChapterSource(original)) {
    const originalAst = parseChapterTranslation(original), translatedAst = parseChapterTranslation(original, simplified);
    const paragraphs = new Map(originalAst.children.map(node => [node.id, stripChapterMarkers(serializeChapterAst(node))]));
    function convertNode(node, context) {
      if (node.type === 'text') node.value = convertText(context, node.value);
      else for (const child of node.children ?? []) convertNode(child, context);
    }
    for (const paragraph of translatedAst.children) convertNode(paragraph, paragraphs.get(paragraph.id));
    const traditional = serializeChapterAst(translatedAst);
    validateChapterTranslation(original, traditional);
    return traditional;
  }
  const exactLabel = interfaceLabels.get(normalize(original));
  if (exactLabel && simplified === exactLabel[0] && relevantTerms([original]).length === 0) return exactLabel[1];
  return applyTraditionalTerminology(original, convert(simplified), convert);
}

async function atomicJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function convertToTraditional({ rootDir = root, log = console.log } = {}) {
  const strings = JSON.parse(await readFile(resolve(rootDir, '.cache/source/strings.json'), 'utf8'));
  const simplified = JSON.parse(await readFile(resolve(rootDir, 'generated/locales/zh-Hans.json'), 'utf8'));
  if (!Array.isArray(strings) || !strings.every(text => typeof text === 'string') || new Set(strings).size !== strings.length) throw new Error('Invalid or duplicate source strings.');
  if (!simplified || typeof simplified !== 'object' || Array.isArray(simplified)) throw new Error('Simplified locale must be an object.');
  const catalog = await readUnitCatalog(rootDir, strings);
  const traditional = Object.create(null);
  for (const text of strings) {
    if (!Object.hasOwn(simplified, text)) continue;
    const translation = simplified[text];
    if (typeof translation !== 'string' || !translation.trim()) throw new Error('Simplified locale has an empty or invalid translation.');
    traditional[text] = convertText(text, translation);
  }
  const converted = Object.keys(traditional).length;
  const complete = strings.length > 0 && converted === strings.length;
  const metadata = {
    sourceHash: sourceHash(strings), simplifiedHash: hashLocale(simplified), traditionalHash: hashLocale(traditional),
    terminologyHash: TERMINOLOGY_HASH, converter: CONVERTER, total: strings.length, converted, complete,
    ...(catalog ? { unitCatalogHash: catalog.catalogHash } : {}),
  };
  // Write derivation metadata last. An interrupted run cannot make stale output look current.
  await atomicJSON(resolve(rootDir, 'generated/locales/zh-Hant.json'), traditional);
  await atomicJSON(resolve(rootDir, 'generated/translation-status.json'), {
    sourceHash: metadata.sourceHash, total: strings.length,
    ...(catalog ? { unitCatalogHash: catalog.catalogHash, units: catalog.stats } : {}),
    languages: {
      'zh-Hans': { translated: converted, total: strings.length, complete },
      'zh-Hant': { translated: converted, total: strings.length, complete, derived: true },
    },
  });
  await atomicJSON(resolve(rootDir, 'generated/conversion-status.json'), metadata);
  log(`${complete ? 'COMPLETE' : 'PARTIAL'}: OpenCC + terminology converted ${converted}/${strings.length} texts to Traditional Chinese. No API calls.`);
  return metadata;
}
