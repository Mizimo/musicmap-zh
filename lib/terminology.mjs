import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const TERMINOLOGY = JSON.parse(readFileSync(new URL('../data/terminology.json', import.meta.url), 'utf8'));
export const TERMINOLOGY_HASH = createHash('sha256').update(JSON.stringify(TERMINOLOGY)).digest('hex');
export const SIMPLIFIED_TERMINOLOGY_HASH = createHash('sha256').update(JSON.stringify(TERMINOLOGY.terms.map(({ english, simplified }) => ({ english, simplified })))).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function relevantTerms(texts) {
  const source = texts.join('\n');
  return TERMINOLOGY.terms.filter(term => term.english.some(alias => new RegExp(`(?:^|[^a-z0-9])${escape(alias)}(?=$|[^a-z0-9])`, 'i').test(source)));
}

export function glossaryPrompt(texts) {
  return relevantTerms(texts).map(term => `${term.english[0]} = ${term.simplified}`).join('\n');
}

// Preserve links, English proper names and URLs; match only complete English genre terms.
export function applyTraditionalTerminology(original, converted, convert) {
  const replacements = relevantTerms([original]).map(term => [convert(term.simplified), term.traditional]);
  const mapping = new Map(replacements.filter(([from, to]) => from !== to));
  if (!mapping.size) return converted;
  const pattern = [...mapping.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
  return converted.replace(new RegExp(pattern, 'g'), match => mapping.get(match));
}
