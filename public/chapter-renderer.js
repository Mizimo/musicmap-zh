// Shared, dependency-free protocol parser. Model output is data, never HTML.
const tokenPattern = /⟦(\/?)(p|m|br)(\d+)⟧/g;
export const isChapterSource = value => typeof value === 'string' && /^⟦p0⟧/.test(value);

function parseMarked(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Chapter translation must be nonempty text.');
  if (/<\/?[a-z][^>]*>/i.test(text)) throw new Error('Chapter output must not contain HTML.');
  const root = { type: 'root', children: [] }, stack = [root], seen = new Map();
  let end = 0;
  function addText(value) {
    if (/[⟦⟧]/.test(value)) throw new Error('Unknown or malformed chapter marker.');
    if (stack.length === 1) { if (value.trim()) throw new Error('Text outside a paragraph.'); return; }
    if (value) stack.at(-1).children.push({ type: 'text', value });
  }
  for (const match of text.matchAll(tokenPattern)) {
    addText(text.slice(end, match.index)); end = match.index + match[0].length;
    const [, closing, kind, number] = match, id = kind + number;
    if (closing) {
      if (kind === 'br' || stack.at(-1).id !== id) throw new Error(`Unbalanced chapter marker ${id}.`);
      stack.pop(); continue;
    }
    if (seen.has(id)) throw new Error(`Duplicate chapter marker ${id}.`);
    if ((kind === 'p') !== (stack.length === 1)) throw new Error('Paragraphs cannot nest; inline markers must belong to a paragraph.');
    const node = { type: kind === 'p' ? 'paragraph' : kind === 'br' ? 'break' : 'marker', id, ...(kind !== 'br' ? { children: [] } : {}) };
    seen.set(id, { parent: stack.at(-1).id ?? null, node });
    stack.at(-1).children.push(node);
    if (kind !== 'br') stack.push(node);
  }
  addText(text.slice(end));
  if (stack.length !== 1 || !root.children.length) throw new Error('Unclosed or missing chapter paragraphs.');
  const visible = node => node.type === 'text' ? node.value : node.type === 'break' ? '\n' : node.children.map(visible).join('');
  for (const node of root.children) if (!visible(node).trim()) throw new Error('Empty chapter paragraph.');
  return { root, seen, visible };
}

export function parseChapterTranslation(source, translation = source) {
  const before = parseMarked(source), after = parseMarked(translation);
  if (before.root.children.map(n => n.id).join(',') !== after.root.children.map(n => n.id).join(',')) throw new Error('Paragraph IDs or order changed.');
  if (before.seen.size !== after.seen.size) throw new Error('Chapter marker count changed.');
  for (const [id, original] of before.seen) {
    const result = after.seen.get(id);
    if (!result || result.parent !== original.parent) throw new Error(`Chapter marker ${id} is missing or moved across a paragraph/parent.`);
    if (original.node.type === 'marker' && before.visible(original.node).trim() && !after.visible(result.node).trim()) throw new Error(`Chapter marker ${id} became empty.`);
  }
  return after.root;
}

export function validateChapterTranslation(source, translation) {
  parseChapterTranslation(source, translation); return true;
}

export function stripChapterMarkers(text) {
  const { root, visible } = parseMarked(text);
  return root.children.map(visible).join('\n\n');
}

export function serializeChapterAst(node) {
  if (node.type === 'text') return node.value;
  if (node.type === 'break') return `⟦${node.id}⟧`;
  if (node.type === 'root') return node.children.map(serializeChapterAst).join('\n');
  return `⟦${node.id}⟧${node.children.map(serializeChapterAst).join('')}⟦/${node.id}⟧`;
}

function snapshot(node) {
  return { node, value: node.nodeValue, children: [...node.childNodes].map(snapshot) };
}
function restore(saved) {
  if (![1, 9, 11].includes(saved.node.nodeType)) { saved.node.nodeValue = saved.value; return; }
  for (const child of saved.children) restore(child);
  saved.node.replaceChildren(...saved.children.map(child => child.node));
}
const normalize = text => text.replace(/\s+/g, ' ').trim();
const nodeAt = (root, path) => path.reduce((node, index) => node?.childNodes[index], root);

/** Moves existing inline nodes, preserving their handlers and source attributes. */
export function createChapterRenderer({ document, catalog, lookup }) {
  const units = catalog?.units ?? [], states = new Map();
  const genreUnits = units.filter(unit => unit.kind === 'genre');
  const genreByText = new Map();
  for (const unit of genreUnits) {
    const key = unit.plainText;
    if (!genreByText.has(key)) genreByText.set(key, unit);
  }
  function capture(element, unit) {
    const original = snapshot(element), nodes = {};
    for (const [id, marker] of Object.entries(unit.markers)) {
      const node = nodeAt(element, marker.path);
      if (!node || node.nodeType !== 1 || node.tagName.toLowerCase() !== marker.tag) throw new Error(`Source DOM no longer matches ${unit.id}/${id}.`);
      nodes[id] = node;
    }
    const separators = unit.layout.map(part => part.type === 'separator' ? part.paths.map(path => nodeAt(element, path)) : null);
    const state = { unit, original, nodes, separators, applied: null, children: [...element.childNodes] };
    states.set(element, state); element.setAttribute('data-mmzh-chapter', unit.id);
    return state;
  }
  function sameGeneration(element, state) {
    return state.children.length === element.childNodes.length && state.children.every((node, index) => element.childNodes[index] === node);
  }
  function locate() {
    for (const [element] of states) if (!element.isConnected) states.delete(element);
    for (const unit of units.filter(item => item.kind === 'page')) {
      for (const target of unit.targets) {
        const element = document.querySelector(target.selector);
        if (!element) continue;
        const state = states.get(element);
        if (state && sameGeneration(element, state)) continue;
        if (normalize(element.textContent) === unit.plainText) capture(element, unit);
      }
    }
    for (const selector of ['#right-side-pane-genre-description', '#supergenre-side-pane-genre-description']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      // The pane is always managed, including while empty or while changing genre.
      element.setAttribute('data-mmzh-chapter', 'pending');
      const state = states.get(element);
      if (state && sameGeneration(element, state)) { element.setAttribute('data-mmzh-chapter', state.unit.id); continue; }
      states.delete(element);
      const unit = genreByText.get(normalize(element.textContent));
      if (unit) capture(element, unit);
    }
  }
  function draw(element, state, value) {
    const ast = parseChapterTranslation(state.unit.source, value);
    const byParagraph = new Map(ast.children.map(node => [node.id, node]));
    const make = node => {
      if (node.type === 'text') return document.createTextNode(node.value);
      const element = state.nodes[node.id];
      if (!element) throw new Error(`Missing source node ${node.id}.`);
      if (node.type === 'marker') element.replaceChildren(...node.children.map(make));
      return element;
    };
    const children = [];
    state.unit.layout.forEach((part, index) => {
      if (part.type === 'separator') children.push(...state.separators[index]);
      else children.push(...byParagraph.get(part.id).children.map(make));
    });
    element.replaceChildren(...children);
  }
  return {
    locate,
    apply(language) {
      for (const [element, state] of states) {
        const value = language === 'en' ? null : lookup(state.unit.source, language) || null;
        if (state.applied === value) continue;
        // Restore first so switching Chinese scripts and falling back to EN use
        // the same original nodes, not a previous translation as their source.
        restore(state.original);
        if (value) draw(element, state, value);
        state.applied = value;
        state.children = [...element.childNodes];
      }
    },
    managed(node) { return Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest('[data-mmzh-chapter]')); },
  };
}
