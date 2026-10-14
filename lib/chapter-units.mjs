import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { EXCLUDED_SELECTOR, TEXT_ATTRIBUTES, extractHtmlStrings, extractGenreStrings, extractBundleStrings, normalizeText } from '../scripts/sync-source.mjs';
import { isChapterSource, parseChapterTranslation, validateChapterTranslation, stripChapterMarkers, serializeChapterAst } from '../public/chapter-renderer.js';

export { isChapterSource, parseChapterTranslation, validateChapterTranslation, stripChapterMarkers, serializeChapterAst };
export const CHAPTER_PROTOCOL = 'musicmap-chapters-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const useful = value => /[a-zA-Z]{2}/.test(value);

/** Full paragraphs are encoded together. Tags are registry-owned data. */
export function encodeChapter({ id, kind = 'genre', genreId, title = '', html, targets = [] }) {
  const $ = load(String(html), null, false), root = $.root()[0];
  const markers = {}, paragraphs = [], layout = [], encoded = [];
  let markerNumber = 0, breakNumber = 0;
  const pathOf = node => {
    const path = [];
    while (node !== root) { path.unshift(node.parent.children.indexOf(node)); node = node.parent; }
    return path;
  };
  function encode(node, paragraph, parent = null) {
    if (node.type === 'text') {
      if (/[⟦⟧]/.test(node.data)) throw new Error(`Source ${id} contains reserved marker delimiters.`);
      return node.data;
    }
    if (node.type === 'comment') return '';
    if (!node.name) throw new Error(`Unsupported source node in ${id}.`);
    if (['script', 'style', 'iframe', 'textarea', 'noscript'].includes(node.name)) throw new Error(`Unsafe prose element ${node.name} in ${id}.`);
    const marker = node.name === 'br' ? `br${breakNumber++}` : `m${markerNumber++}`;
    markers[marker] = { tag: node.name.toLowerCase(), attributes: { ...node.attribs }, path: pathOf(node), parent, paragraph };
    if (node.name === 'br') return `⟦${marker}⟧`;
    return `⟦${marker}⟧${(node.children ?? []).map(child => encode(child, paragraph, marker)).join('')}⟦/${marker}⟧`;
  }
  let nodes = [];
  function flush() {
    const english = normalizeText(nodes.map(node => $(node).text()).join(''));
    if (!english) {
      if (nodes.length) layout.push({ type: 'separator', paths: nodes.map(pathOf) });
      nodes = []; return;
    }
    const paragraphId = `p${paragraphs.length}`;
    const content = normalizeText(nodes.map(node => encode(node, paragraphId)).join(''));
    paragraphs.push({ id: paragraphId, english });
    encoded.push(`⟦${paragraphId}⟧${content}⟦/${paragraphId}⟧`);
    layout.push({ type: 'paragraph', id: paragraphId });
    nodes = [];
  }
  const children = root.children;
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node.name === 'br') {
      let last = index, count = 0;
      while (last < children.length && (children[last].name === 'br' || (children[last].type === 'text' && !children[last].data.trim()))) {
        if (children[last].name === 'br') count++;
        last++;
      }
      if (count >= 2) {
        flush(); layout.push({ type: 'separator', paths: children.slice(index, last).map(pathOf) });
        index = last - 1; continue;
      }
    }
    nodes.push(node);
  }
  flush();
  if (!paragraphs.length) throw new Error(`Chapter ${id} is empty.`);
  const source = encoded.join('\n');
  if (source.length > 5000) throw new Error(`Complete chapter ${id} exceeds the unchanged 5000-character input limit (${source.length}); choose whole paragraph boundaries, never truncate text.`);
  validateChapterTranslation(source, source);
  return { id, kind, ...(genreId ? { genreId } : {}), title, html: String(html), plainText: normalizeText($(root).text()), source, sourceHash: hash(source), paragraphs, markers, layout, targets };
}

function selectorFor($, node) {
  const parts = [];
  while (node?.name && node.name !== 'html') {
    if (node.attribs?.id && /^[A-Za-z][\w-]*$/.test(node.attribs.id) && $(`[id="${node.attribs.id}"]`).length === 1) {
      parts.unshift(`#${node.attribs.id}`); return parts.join(' > ');
    }
    const peers = node.parent?.children.filter(peer => peer.name === node.name) ?? [node];
    parts.unshift(`${node.name}:nth-of-type(${peers.indexOf(node) + 1})`);
    node = node.parent;
  }
  return parts.join(' > ');
}

export function hashUnitCatalog(catalog) {
  const { catalogHash: ignored, ...content } = catalog;
  return hash(JSON.stringify(content));
}

/** Extract from the frozen snapshot only. The baseline text-node corpus is not reused as prose. */
export function createUnitCatalog({ html = '', genres = {}, bundle = '' } = {}) {
  const units = [], labels = [];
  for (const [genreId, genre] of Object.entries(genres)) {
    if (!genre || typeof genre !== 'object') continue;
    if (typeof genre.description === 'string' && useful(load(genre.description, null, false).text())) {
      units.push(encodeChapter({ id: `genre:${genreId}`, genreId, title: normalizeText(load(genre.name ?? '', null, false).text()), html: genre.description }));
      const attrs = load(genre.description, null, false);
      attrs('*').each((_, element) => { for (const attr of TEXT_ATTRIBUTES) if (element.attribs?.[attr]) labels.push(normalizeText(element.attribs[attr])); });
    }
    const withoutDescription = { ...genre }; delete withoutDescription.description;
    labels.push(...extractGenreStrings({ [genreId]: withoutDescription }));
  }
  const $ = load(html), managed = new Set();
  const excluded = node => $(node).closest(`${EXCLUDED_SELECTOR},svg,#mmzh-root`).length > 0;
  const hasManagedAncestor = node => { while (node?.parent) { node = node.parent; if (managed.has(node)) return true; } return false; };
  function addPage(node) {
    if (excluded(node) || hasManagedAncestor(node) || managed.has(node) || !useful($(node).text())) return;
    if ($(node).find(EXCLUDED_SELECTOR).length) return;
    const selector = selectorFor($, node), titleNode = $(node).closest('[id]').attr('id') || 'Musicmap';
    const content = $(node).html();
    const id = `page:${hash(selector).slice(0,16)}`;
    units.push(encodeChapter({ id, kind: 'page', title: titleNode, html: content, targets: [{ selector }] }));
    managed.add(node);
  }
  // Full <p> blocks, not individual descendants around emphasis or links.
  $('p,blockquote,dd').each((_, node) => {
    if (!$(node).find('p,blockquote,dd').length) addPage(node);
  });
  // Narrative list entries and other inline-only prose blocks are likewise whole.
  $('li,div,section,article').each((_, node) => {
    if (excluded(node) || managed.has(node) || hasManagedAncestor(node) || $(node).find('p,div,section,article,ul,ol,li,table,svg,input,button,select').length) return;
    const text = normalizeText($(node).text());
    const citation = node.name === 'li' && $(node).closest('#acknowledgements-literature-list').length > 0;
    if (citation || (text.length >= 80 && (/[.!?:;]/.test(text) || text.length >= 180))) addPage(node);
  });
  // Keep all readable attributes, including attributes inside managed paragraphs.
  $('*').each((_, node) => {
    if ($(node).closest(EXCLUDED_SELECTOR).length) return;
    for (const attribute of TEXT_ATTRIBUTES) if (node.attribs?.[attribute]) labels.push(normalizeText(node.attribs[attribute]));
  });
  // Remove only the managed prose from the copy used to extract independent UI labels.
  for (const node of managed) $(node).empty();
  labels.push(...extractHtmlStrings($.html()), ...extractBundleStrings(bundle));
  const source = [...new Set([...units.map(unit => unit.source), ...labels.filter(useful)])];
  const catalog = {
    schemaVersion: 1, protocol: CHAPTER_PROTOCOL,
    snapshotHash: hash(JSON.stringify({ html, genres, bundle })),
    source, sourceHash: hash(JSON.stringify(source)), units,
    stats: { genres: units.filter(u => u.kind === 'genre').length, pageUnits: units.filter(u => u.kind === 'page').length,
      paragraphs: units.reduce((sum, unit) => sum + unit.paragraphs.length, 0), units: source.length,
      labels: source.filter(text => !isChapterSource(text)).length, maxChapterCharacters: Math.max(0, ...units.map(unit => unit.source.length)) },
  };
  catalog.catalogHash = hashUnitCatalog(catalog);
  return catalog;
}

export function validateUnitCatalog(catalog, source = catalog?.source) {
  if (catalog?.schemaVersion !== 1 || catalog.protocol !== CHAPTER_PROTOCOL || !Array.isArray(catalog.units) ||
      catalog.catalogHash !== hashUnitCatalog(catalog) || catalog.sourceHash !== hash(JSON.stringify(source)) ||
      JSON.stringify(source) !== JSON.stringify(catalog.source)) throw new Error('Chapter unit registry is invalid or does not match the source corpus.');
  const known = new Set(source);
  for (const unit of catalog.units) {
    if (!known.has(unit.source) || unit.sourceHash !== hash(unit.source)) throw new Error('Chapter unit source hash mismatch.');
    validateChapterTranslation(unit.source, unit.source);
  }
  return catalog;
}

export async function readUnitCatalog(rootDir, source) {
  let bytes;
  try { bytes = await readFile(resolve(rootDir, '.cache/source/units.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') { if (source?.some(isChapterSource)) throw new Error('Chapter sources require their immutable unit registry.'); return null; } throw error; }
  return validateUnitCatalog(JSON.parse(bytes), source);
}
