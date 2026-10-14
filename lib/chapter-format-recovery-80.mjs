import { parseChapterTranslation, validateChapterTranslation } from '../public/chapter-renderer.js';

// Only repair the JSON/paragraph envelope. Never generate, remove, reorder, or
// replace any translated text or inline marker. The original validator remains
// the final authority, and the original failed request remains immutable.
export function recoverChapterFormat(source, responseText) {
  try {
    let payload, escapedLineBreaks = 0;
    try { payload = JSON.parse(responseText); }
    catch {
      // Some responses contain literal LF/CR inside a JSON string. Escaping
      // those characters changes only JSON encoding, not decoded prose.
      let encoded = '', quoted = false, escaped = false;
      for (const char of responseText) {
        if (quoted && !escaped && (char === '\n' || char === '\r')) {
          encoded += char === '\n' ? '\\n' : '\\r'; escapedLineBreaks++; continue;
        }
        encoded += char;
        if (escaped) escaped = false;
        else if (quoted && char === '\\') escaped = true;
        else if (char === '"') quoted = !quoted;
      }
      if (!escapedLineBreaks) return null;
      payload = JSON.parse(encoded);
    }
    if (!payload || Array.isArray(payload) || Object.keys(payload).length !== 1 || !Array.isArray(payload.translations)
      || !payload.translations.length || payload.translations.some(t => typeof t !== 'string' || !t.trim())) return null;
    const paragraphs = parseChapterTranslation(source).children;
    const items = payload.translations;
    if (escapedLineBreaks) {
      if (items.length !== 1) return null;
      validateChapterTranslation(source, items[0]);
      return { kind: 'escape-json-literal-line-breaks', translation: items[0], responseItems: 1,
        sourceParagraphs: paragraphs.length, translatedTextChanged: false, inlineMarkersChanged: false,
        addedPaidRequests: 0, escapedLineBreaks };
    }
    let translation, kind, explicitSeparator;
    if (paragraphs.length === 1 && items.length === 1 && !/⟦\/?p\d+⟧/.test(items[0])) {
      translation = `⟦${paragraphs[0].id}⟧${items[0]}⟦/${paragraphs[0].id}⟧`;
      kind = 'restore-single-paragraph-envelope';
    } else if (items.length > 1 && items.length === paragraphs.length
      && items.every((item, i) => item.startsWith(`⟦${paragraphs[i].id}⟧`) && item.endsWith(`⟦/${paragraphs[i].id}⟧`))) {
      translation = items.join('\n');
      kind = 'join-paragraph-array-in-source-order';
    } else if (items.length > 1 && items.length === paragraphs.length
      && paragraphs.every(p => p.children.some(node => node.type === 'marker'))) {
      // Array items already specify boundaries; marker ownership must identify
      // each source paragraph. Only missing outer envelopes may be added.
      translation = items.map((part, i) => {
        const first = `⟦${paragraphs[i].id}⟧`, last = `⟦/${paragraphs[i].id}⟧`;
        return (part.includes(first) ? '' : first) + part + (part.includes(last) ? '' : last);
      }).join('\n');
      kind = 'restore-paragraph-array-envelopes';
    } else if (items.length === 1 && paragraphs.length > 1 && !/⟦\/?p\d+⟧/.test(items[0])
      && paragraphs.every(p => p.children.some(node => node.type === 'marker'))) {
      // The response must already separate its paragraphs. Accept only one
      // interpretation, with the exact source count and inline-marker ownership.
      // A prose-only paragraph has no marker anchors and is deliberately excluded.
      const candidates = [];
      for (const separator of ['\n\n', '\n', '\\n\\n', '\\n']) {
        const parts = items[0].split(separator);
        if (parts.length !== paragraphs.length || parts.some(p => !p.trim())) continue;
        const value = parts.map((part, i) => `⟦${paragraphs[i].id}⟧${part}⟦/${paragraphs[i].id}⟧`).join('\n');
        try { validateChapterTranslation(source, value); candidates.push({ separator, value }); } catch {}
      }
      if (new Set(candidates.map(c => c.value)).size !== 1) return null;
      translation = candidates[0].value; explicitSeparator = candidates[0].separator;
      kind = 'restore-explicit-paragraph-breaks';
    } else if (items.length === 1) {
      const first = `⟦${paragraphs[0].id}⟧`, last = `⟦/${paragraphs.at(-1).id}⟧`;
      const missingFirst = !items[0].includes(first), missingLast = !items[0].includes(last);
      if (!missingFirst && !missingLast) return null;
      // Only the two outermost boundaries can be inferred. Internal paragraph
      // boundaries and all inline markers still have to pass the original parser.
      translation = (missingFirst ? first : '') + items[0] + (missingLast ? last : '');
      kind = missingFirst && missingLast ? 'restore-chapter-outer-boundaries'
        : missingFirst ? 'restore-first-paragraph-open' : 'restore-last-paragraph-close';
    } else return null;
    validateChapterTranslation(source, translation);
    return { kind, translation, responseItems: items.length, sourceParagraphs: paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: false, addedPaidRequests: 0,
      ...(explicitSeparator === undefined ? {} : { explicitSeparator }) };
  } catch { return null; }
}

// This path is never inferred from a response. The runner must first verify a
// request-specific correction frozen in the manifest, including payload hashes.
export function recoverReviewedDuplicateBold(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-format-correction' || !/^m\d+$/.test(correction.markerId)
      || correction.expectedOccurrences !== 2 || ![1, 2].includes(correction.removeOccurrence)) return null;
    const marker = unit.markers[correction.markerId];
    if (marker?.tag !== 'b' || Object.keys(marker.attributes).length || marker.parent !== null) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0], pattern = new RegExp(`⟦${correction.markerId}⟧([\\s\\S]*?)⟦/${correction.markerId}⟧`, 'g');
    const occurrences = [...raw.matchAll(pattern)];
    if (occurrences.length !== 2 || occurrences[0][1] !== occurrences[1][1] || /[⟦⟧]/.test(occurrences[0][1])) return null;
    let occurrence = 0;
    const translation = raw.replace(pattern, (all, text) => ++occurrence === correction.removeOccurrence ? text : all);
    const visible = text => text.replace(/⟦\/?(?:p|m|br)\d+⟧/g, '');
    if (visible(raw) !== visible(translation)) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-duplicate-bold-marker', translation, responseItems: 1, sourceParagraphs: unit.paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: true, addedPaidRequests: 0,
      removedDuplicate: { markerId: correction.markerId, occurrence: correction.removeOccurrence } };
  } catch { return null; }
}

// Restoring a missing emphasis requires an exact, individually reviewed text
// anchor. The runner binds this proof to the source and original paid journal.
export function recoverReviewedMissingBold(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-missing-bold-correction' || !/^m\d+$/.test(correction.markerId)
      || !correction.sourceText || !correction.translatedText || /[⟦⟧]/.test(correction.translatedText)) return null;
    const { markerId, sourceText, translatedText } = correction, marker = unit.markers[markerId];
    if (marker?.tag !== 'b' || Object.keys(marker.attributes).length || marker.parent !== null) return null;
    if (!unit.source.includes(`⟦${markerId}⟧${sourceText}⟦/${markerId}⟧`)) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0];
    if (raw.includes(`⟦${markerId}⟧`) || raw.includes(`⟦/${markerId}⟧`)) return null;
    const paragraph = raw.match(new RegExp(`⟦${marker.paragraph}⟧([\\s\\S]*?)⟦/${marker.paragraph}⟧`));
    if (!paragraph || paragraph[1].split(translatedText).length !== 2) return null;
    const offset = paragraph.index + `⟦${marker.paragraph}⟧`.length + paragraph[1].indexOf(translatedText);
    const translation = raw.slice(0, offset) + `⟦${markerId}⟧${translatedText}⟦/${markerId}⟧` + raw.slice(offset + translatedText.length);
    if (translation.replace(`⟦${markerId}⟧`, '').replace(`⟦/${markerId}⟧`, '') !== raw) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-missing-bold-marker', translation, responseItems: 1, sourceParagraphs: unit.paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: true, addedPaidRequests: 0,
      restoredMarker: { markerId, paragraph: marker.paragraph, sourceText, translatedText } };
  } catch { return null; }
}

// Two missing emphases may be restored only with two explicitly reviewed
// source/translation anchors in a request-specific, hash-bound proof.
export function recoverReviewedMissingBoldPair(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-missing-bold-pair-correction' || correction.markers?.length !== 2
      || new Set(correction.markers.map(m => m.markerId)).size !== 2) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0], restoredMarkers = [];
    let translation = raw;
    for (const { markerId, sourceText, translatedText } of correction.markers) {
      if (!/^m\d+$/.test(markerId) || !sourceText || !translatedText || /[⟦⟧]/.test(translatedText)) return null;
      const marker = unit.markers[markerId];
      if (marker?.tag !== 'b' || Object.keys(marker.attributes).length || marker.parent !== null
        || !unit.source.includes(`⟦${markerId}⟧${sourceText}⟦/${markerId}⟧`)) return null;
      if (raw.includes(`⟦${markerId}⟧`) || raw.includes(`⟦/${markerId}⟧`)) return null;
      const paragraph = translation.match(new RegExp(`⟦${marker.paragraph}⟧([\\s\\S]*?)⟦/${marker.paragraph}⟧`));
      if (!paragraph || paragraph[1].split(translatedText).length !== 2) return null;
      const offset = paragraph.index + `⟦${marker.paragraph}⟧`.length + paragraph[1].indexOf(translatedText);
      translation = translation.slice(0, offset) + `⟦${markerId}⟧${translatedText}⟦/${markerId}⟧` + translation.slice(offset + translatedText.length);
      restoredMarkers.push({ markerId, paragraph: marker.paragraph, sourceText, translatedText });
    }
    let original = translation;
    for (const { markerId } of restoredMarkers) original = original.replace(`⟦${markerId}⟧`, '').replace(`⟦/${markerId}⟧`, '');
    if (original !== raw) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-missing-bold-pair', translation, responseItems: 1, sourceParagraphs: unit.paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: true, addedPaidRequests: 0, restoredMarkers };
  } catch { return null; }
}

// A reviewed bibliography title may lack only its opening bold marker. This
// never runs without a request-specific proof; the existing closing marker and
// plain span parent must already identify the reviewed title's exact end.
export function recoverReviewedMissingBoldOpen(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-missing-bold-open-correction'
      || !/^m\d+$/.test(correction.markerId) || !/^m\d+$/.test(correction.parentMarkerId)
      || !correction.sourceText || !correction.translatedText || /[⟦⟧]/.test(correction.translatedText)) return null;
    const { markerId, parentMarkerId, sourceText, translatedText } = correction;
    const marker = unit.markers[markerId], parent = unit.markers[parentMarkerId];
    if (marker?.tag !== 'b' || Object.keys(marker.attributes).length || marker.parent !== parentMarkerId
      || parent?.tag !== 'span' || Object.keys(parent.attributes).length || parent.parent !== null
      || marker.paragraph !== parent.paragraph
      || !unit.source.includes(`⟦${markerId}⟧${sourceText}⟦/${markerId}⟧`)) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0], open = `⟦${markerId}⟧`, close = `⟦/${markerId}⟧`;
    if (raw.includes(open) || raw.split(close).length !== 2 || raw.split(translatedText).length !== 2) return null;
    const offset = raw.indexOf(translatedText);
    if (offset + translatedText.length !== raw.indexOf(close)) return null;
    const translation = raw.slice(0, offset) + open + raw.slice(offset);
    if (translation.replace(open, '') !== raw) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-missing-bold-open', translation, responseItems: 1, sourceParagraphs: unit.paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: true, addedPaidRequests: 0,
      restoredMarker: { markerId, parentMarkerId, paragraph: marker.paragraph, sourceText, translatedText,
        insertedAtUtf16: offset, existingClosePreserved: true } };
  } catch { return null; }
}

// Individually reviewed bibliography titles only. Both bold markers are absent,
// while the original noninteractive span parent and all prose remain intact.
// Unlike envelope recovery, this path requires a separately frozen hash proof.
export function recoverReviewedMissingNestedBold(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-missing-nested-bold-correction'
      || unit.kind !== 'page' || unit.title !== 'acknowledgements-literature-list'
      || !/^m\d+$/.test(correction.markerId) || !/^m\d+$/.test(correction.parentMarkerId)
      || !correction.sourceText || !correction.translatedText || /[⟦⟧]/.test(correction.translatedText)) return null;
    const { markerId, parentMarkerId, sourceText, translatedText } = correction;
    const marker = unit.markers[markerId], parent = unit.markers[parentMarkerId];
    if (marker?.tag !== 'b' || Object.keys(marker.attributes).length || marker.parent !== parentMarkerId
      || parent?.tag !== 'span' || Object.keys(parent.attributes).length || parent.parent !== null
      || marker.paragraph !== parent.paragraph
      || !unit.source.includes(`⟦${markerId}⟧${sourceText}⟦/${markerId}⟧`)) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0], open = `⟦${markerId}⟧`, close = `⟦/${markerId}⟧`;
    if (raw.includes(open) || raw.includes(close) || raw.split(translatedText).length !== 2) return null;
    const offset = raw.indexOf(translatedText);
    const translation = raw.slice(0, offset) + open + translatedText + close + raw.slice(offset + translatedText.length);
    if (translation.replace(open, '').replace(close, '') !== raw) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-missing-nested-bold', translation, responseItems: 1, sourceParagraphs: unit.paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: true, addedPaidRequests: 0,
      restoredMarker: { markerId, parentMarkerId, paragraph: marker.paragraph, sourceText, translatedText, insertedAtUtf16: offset } };
  } catch { return null; }
}

// This is an individually reviewed mapping of original paragraph starts, never
// an automatic guess from punctuation. Each paragraph needs source-owned markers.
export function recoverReviewedParagraphBoundaries(unit, responseText, correction) {
  try {
    if (correction?.type !== 'reviewed-paragraph-boundary-correction') return null;
    const paragraphs = parseChapterTranslation(unit.source).children, starts = correction.paragraphStarts;
    if (paragraphs.length < 2 || !Array.isArray(starts) || starts.length !== paragraphs.length
      || !paragraphs.every(p => p.children.some(n => n.type === 'marker'))) return null;
    const payload = JSON.parse(responseText);
    if (Object.keys(payload).length !== 1 || payload.translations?.length !== 1 || typeof payload.translations[0] !== 'string') return null;
    const raw = payload.translations[0];
    if (/⟦\/?p\d+⟧/.test(raw)) return null;
    const offsets = starts.map((start, i) => {
      if (start.paragraph !== paragraphs[i].id || typeof start.translatedPrefix !== 'string' || !start.translatedPrefix.trim()
        || raw.split(start.translatedPrefix).length !== 2) throw new Error('Ambiguous paragraph start');
      return raw.indexOf(start.translatedPrefix);
    });
    if (offsets[0] !== 0 || offsets.some((v, i) => i > 0 && v <= offsets[i - 1])) return null;
    const translation = paragraphs.map((p, i) => `⟦${p.id}⟧${raw.slice(offsets[i], offsets[i + 1])}⟦/${p.id}⟧`).join('');
    if (translation.replace(/⟦\/?p\d+⟧/g, '') !== raw) return null;
    validateChapterTranslation(unit.source, translation);
    return { kind: 'reviewed-paragraph-boundaries', translation, responseItems: 1, sourceParagraphs: paragraphs.length,
      translatedTextChanged: false, inlineMarkersChanged: false, addedPaidRequests: 0, paragraphStarts: starts, offsets };
  } catch { return null; }
}
