// Build-only adapter for the two source captions beside dynamically loaded SVGs.
// The original chapter parser, catalog, translations, and other renderers remain unchanged.
import { createChapterRenderer as createBaseRenderer, parseChapterTranslation } from './chapter-renderer.js';

const captionSelectors = new Set(['#genres-relations', '#supergenres-blueprint']);
const normalize = text => text.replace(/\s+/g, ' ').trim();

export function createChapterRenderer({ document, catalog, lookup }) {
  const captions = catalog.units.filter(unit => unit.kind === 'page'
    && unit.targets.length === 1 && captionSelectors.has(unit.targets[0].selector));
  const captionIds = new Set(captions.map(unit => unit.id));
  const base = createBaseRenderer({ document, lookup,
    catalog: { ...catalog, units: catalog.units.filter(unit => !captionIds.has(unit.id)) } });
  const states = new Map();
  return {
    locate() {
      base.locate();
      for (const [label] of states) if (!label.isConnected) states.delete(label);
      for (const unit of captions) {
        const label = document.querySelector(`${unit.targets[0].selector} > label.image-label`);
        if (!label || states.has(label) || normalize(label.textContent) !== unit.plainText) continue;
        const markers = Object.entries(unit.markers);
        if (markers.length !== 1 || markers[0][1].tag !== 'label' || markers[0][1].parent !== null
          || unit.paragraphs.length !== 1) throw new Error(`Unexpected source caption structure: ${unit.id}`);
        states.set(label, { unit, markerId: markers[0][0], original: [...label.childNodes], applied: null });
      }
    },
    apply(language) {
      base.apply(language);
      for (const [label, state] of states) {
        const value = language === 'en' ? null : lookup(state.unit.source, language) || null;
        if (state.applied === value) continue;
        if (value) {
          const ast = parseChapterTranslation(state.unit.source, value), children = ast.children[0].children;
          if (ast.children.length !== 1 || children.length !== 1 || children[0].id !== state.markerId
            || children[0].children.some(node => node.type !== 'text')) throw new Error(`Unsupported translated caption structure: ${state.unit.id}`);
          label.replaceChildren(document.createTextNode(children[0].children.map(node => node.value).join('')));
        } else label.replaceChildren(...state.original);
        state.applied = value;
      }
    },
    managed(node) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return states.has(element?.closest('label.image-label')) || base.managed(node);
    },
  };
}
