import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeChapter, validateChapterTranslation } from '../lib/chapter-units.mjs';
import { recoverChapterFormat, recoverReviewedMissingBoldOpen, recoverReviewedMissingNestedBold } from '../lib/chapter-format-recovery-80.mjs';

const unit = encodeChapter({ id: 'bibliography-fixture', kind: 'page',
  html: '<span>BORDOWITZ, Hank, <b>Turning Points in Rock and Roll</b>, Citadel Press, New York, 2004.</span>' });
const raw = '⟦p0⟧⟦m0⟧BORDOWITZ, Hank，《摇滚乐的转折点》⟦/m1⟧，Citadel Press，纽约，2004.⟦/m0⟧⟦/p0⟧';
const response = value => JSON.stringify({ translations: [value] });
const proof = { type: 'reviewed-missing-bold-open-correction', markerId: 'm1', parentMarkerId: 'm0',
  sourceText: 'Turning Points in Rock and Roll', translatedText: '《摇滚乐的转折点》' };

test('reviewed missing opening restores only one marker and preserves every original character', () => {
  assert.equal(recoverChapterFormat(unit.source, response(raw)), null);
  const candidate = recoverReviewedMissingBoldOpen(unit, response(raw), proof);
  assert.ok(candidate); validateChapterTranslation(unit.source, candidate.translation);
  assert.equal(candidate.translation.replace('⟦m1⟧', ''), raw);
  assert.equal(candidate.addedPaidRequests, 0);
  assert.equal(candidate.restoredMarker.existingClosePreserved, true);
  assert.equal(candidate.restoredMarker.insertedAtUtf16, raw.indexOf(proof.translatedText));
});
test('missing opening correction rejects absent, duplicated, or non-adjacent closing boundaries', () => {
  for (const text of [raw.replace('⟦/m1⟧', ''), raw.replace('⟦/m1⟧', '⟦/m1⟧⟦/m1⟧'),
    raw.replace('⟦/m1⟧', ' extra⟦/m1⟧'), raw.replace('《', '⟦m1⟧《')]) {
    assert.equal(recoverReviewedMissingBoldOpen(unit, response(text), proof), null);
  }
});
test('missing opening correction rejects ambiguous title, wrong source and wrong parent', () => {
  assert.equal(recoverReviewedMissingBoldOpen(unit, response(raw.replace('Hank，', `Hank，${proof.translatedText}`)), proof), null);
  for (const changed of [{ ...proof, sourceText: 'Another title' }, { ...proof, parentMarkerId: 'm2' },
    { ...proof, translatedText: '摇滚乐的转折点' }, { ...proof, type: 'automatic' }]) {
    assert.equal(recoverReviewedMissingBoldOpen(unit, response(raw), changed), null);
  }
});
test('missing opening correction cannot change link semantics or conceal other structural damage', () => {
  const linkUnit = structuredClone(unit); linkUnit.markers.m1.tag = 'a';
  assert.equal(recoverReviewedMissingBoldOpen(linkUnit, response(raw), proof), null);
  const attributed = structuredClone(unit); attributed.markers.m0.attributes = { id: 'important' };
  assert.equal(recoverReviewedMissingBoldOpen(attributed, response(raw), proof), null);
  assert.equal(recoverReviewedMissingBoldOpen(unit, response(raw.replace('⟦/m0⟧', '')), proof), null);
  assert.equal(recoverReviewedMissingBoldOpen(unit, JSON.stringify({ translations: [raw], extra: true }), proof), null);
});

const nestedUnit = encodeChapter({ id: 'bibliography-pair-fixture', kind: 'page', title: 'acknowledgements-literature-list',
  html: '<span>CATEFORIS, Theo, <b>The Rock History Reader</b>, Routledge, New York, 2007.</span>' });
const nestedRaw = '⟦p0⟧⟦m0⟧CATEFORIS, Theo，《摇滚历史读本》，Routledge，纽约，2007年。⟦/m0⟧⟦/p0⟧';
const nestedProof = { type: 'reviewed-missing-nested-bold-correction', markerId: 'm1', parentMarkerId: 'm0',
  sourceText: 'The Rock History Reader', translatedText: '《摇滚历史读本》' };
test('reviewed nested title pair preserves every character and is never accepted by automatic recovery', () => {
  assert.equal(recoverChapterFormat(nestedUnit.source, response(nestedRaw)), null);
  const candidate = recoverReviewedMissingNestedBold(nestedUnit, response(nestedRaw), nestedProof);
  assert.ok(candidate); validateChapterTranslation(nestedUnit.source, candidate.translation);
  assert.equal(candidate.translation.replace('⟦m1⟧', '').replace('⟦/m1⟧', ''), nestedRaw);
  assert.equal(candidate.restoredMarker.insertedAtUtf16, 24); assert.equal(candidate.addedPaidRequests, 0);
});
test('nested title pair rejects existing markers and repeated title anchors', () => {
  for (const raw of [nestedRaw.replace('《', '⟦m1⟧《'), nestedRaw.replace('》', '》⟦/m1⟧'),
    nestedRaw.replace('Theo，', `Theo，${nestedProof.translatedText}`)]) {
    assert.equal(recoverReviewedMissingNestedBold(nestedUnit, response(raw), nestedProof), null);
  }
});
test('nested title pair excludes general nested tags, attributed spans, and unrelated units', () => {
  for (const mutate of [u => u.markers.m1.tag = 'a', u => u.markers.m0.tag = 'a',
    u => u.markers.m0.attributes = { id: 'x' }, u => u.title = 'other-content', u => u.kind = 'genre']) {
    const changed = structuredClone(nestedUnit); mutate(changed);
    assert.equal(recoverReviewedMissingNestedBold(changed, response(nestedRaw), nestedProof), null);
  }
});
test('nested title pair rejects changed source, wrong parent, missing paragraph, or missing parent', () => {
  for (const proof of [{ ...nestedProof, sourceText: 'Other title' }, { ...nestedProof, parentMarkerId: 'm2' }]) {
    assert.equal(recoverReviewedMissingNestedBold(nestedUnit, response(nestedRaw), proof), null);
  }
  for (const raw of [nestedRaw.replace('⟦/p0⟧', ''), nestedRaw.replace('⟦m0⟧', '')]) {
    assert.equal(recoverReviewedMissingNestedBold(nestedUnit, response(raw), nestedProof), null);
  }
});
