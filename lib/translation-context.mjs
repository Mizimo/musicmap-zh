import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { EXCLUDED_SELECTOR, TEXT_ATTRIBUTES, normalizeText } from '../scripts/sync-source.mjs';

export const CONTEXT_VERSION = 'musicmap-context-v1';
export const MAX_CONTEXT_CHARACTERS = 1600;
const MAX_SNIPPET_CHARACTERS = 800;
const MAX_OCCURRENCES = 3;
const BLOCKS = new Set(['html', 'body', 'div', 'section', 'article', 'aside', 'nav', 'header', 'footer',
  'p', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th', 'blockquote', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'text']);
const SECTION_SCOPES = new Set(['html', 'body', 'div', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'li', 'td', 'th']);

function clip(text, maximum) {
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function excerpt(text, target, maximum) {
  if (text.length <= maximum) return text;
  const position = Math.max(0, text.indexOf(target));
  const start = Math.max(0, Math.min(position - Math.floor(maximum / 3), text.length - maximum + 2));
  const prefix = start ? '…' : '';
  const available = maximum - prefix.length - 1;
  return `${prefix}${text.slice(start, start + available)}…`;
}

/** Reference-only context. Exact source keys and translated DOM node boundaries stay unchanged. */
export function buildTranslationContexts({ html = '', genres = {}, source } = {}) {
  if (!Array.isArray(source) || !source.every(text => typeof text === 'string')) {
    throw new Error('Translation context requires the frozen source string array.');
  }
  const known = new Set(source);
  const occurrences = new Map();
  function add(text, heading, paragraph = '') {
    if (!known.has(text)) return;
    const title = clip(normalizeText(heading), 220);
    // A complete standalone paragraph already appears in texts; repeat only its heading.
    const surrounding = paragraph && paragraph !== text
      ? `\nReference paragraph: ${excerpt(paragraph, text, MAX_SNIPPET_CHARACTERS - title.length - 23)}` : '';
    const candidate = clip(`${title}${surrounding}`, MAX_SNIPPET_CHARACTERS);
    if (!candidate) return;
    const values = occurrences.get(text) ?? [];
    if (values.length < MAX_OCCURRENCES && !values.includes(candidate)) values.push(candidate);
    occurrences.set(text, values);
  }

  function collect(markup, heading) {
    const $ = load(String(markup));
    let section = '';
    let paragraph = [];
    let targets = [];
    const label = () => `${heading}${section ? `; section: ${section}` : ''}`;
    function flush() {
      if (!targets.length) { paragraph = []; return; }
      const reference = normalizeText(paragraph.join(''));
      for (const text of targets) add(text, label(), reference);
      paragraph = []; targets = [];
    }
    function visit(node) {
      if (node.type === 'text') {
        paragraph.push(node.data);
        const text = normalizeText(node.data);
        if (known.has(text)) targets.push(text);
        return;
      }
      if (node.type !== 'root' && $(node).is(EXCLUDED_SELECTOR)) return;
      const name = node.name?.toLowerCase();
      if (name === 'br') { flush(); return; }
      const block = BLOCKS.has(name);
      if (block) flush();
      const previousSection = section;
      if (/^h[1-6]$/.test(name ?? '')) section = clip(normalizeText($(node).text()), 160);
      for (const attribute of TEXT_ATTRIBUTES) {
        const text = normalizeText(node.attribs?.[attribute] ?? '');
        if (known.has(text)) add(text, `${label()}; ${name} attribute: ${attribute}`, normalizeText($(node).text()));
      }
      for (const child of node.children ?? []) visit(child);
      if (block) flush();
      if (SECTION_SCOPES.has(name)) section = previousSection;
    }
    visit($.root()[0]); flush();
  }

  // Genre descriptions provide more useful context than an incidental navigation label.
  for (const [id, genre] of Object.entries(genres)) {
    if (!genre || typeof genre !== 'object') continue;
    const name = normalizeText(load(String(genre.name ?? ''))('body').text());
    const heading = `Genre: ${name || id}`;
    if (typeof genre.name === 'string') add(name, `${heading}; field: genre name`);
    for (const field of ['name', 'description', 'supergenre-first-tag']) {
      if (typeof genre[field] === 'string') collect(genre[field], `${heading}; field: ${field}`);
    }
    if (Array.isArray(genre['supergenre-second-tag']) && typeof genre['supergenre-second-tag'][1] === 'string') {
      collect(genre['supergenre-second-tag'][1], `${heading}; field: supergenre-second-tag`);
    }
    for (const entry of genre.genrelist ?? []) {
      if (typeof entry === 'string') collect(entry, `${heading}; field: genrelist`);
    }
  }
  collect(html, 'Page: Musicmap');
  const contexts = new Map();
  for (const text of source) {
    const values = occurrences.get(text);
    if (!values?.length) continue;
    const budget = Math.floor((MAX_CONTEXT_CHARACTERS - (values.length - 1) * 2) / values.length);
    contexts.set(text, values.map(value => clip(value, budget)).join('\n\n'));
  }
  return contexts;
}

/** Read only the existing snapshot; never fetch, re-extract, or rewrite the source. */
export async function loadTranslationContexts({ rootDir, source } = {}) {
  if (typeof rootDir !== 'string') throw new Error('Translation context requires rootDir.');
  const [html, genreBytes, sourceBytes] = await Promise.all([
    readFile(resolve(rootDir, 'generated/site/index.html'), 'utf8'),
    readFile(resolve(rootDir, 'generated/site/master-genrelist.json'), 'utf8'),
    source === undefined ? readFile(resolve(rootDir, '.cache/source/strings.json'), 'utf8') : Promise.resolve(null),
  ]);
  return buildTranslationContexts({ html, genres: JSON.parse(genreBytes), source: source ?? JSON.parse(sourceBytes) });
}
