import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeChapter,validateChapterTranslation} from '../lib/chapter-units.mjs';
import {sha256} from '../lib/full-site-parent.mjs';
import {recoverReviewedLinkedTitleBold} from '../lib/full-site-format-recovery.mjs';

// Owned fixture. The opaque request/unit identifiers constrain the reviewed path;
// no real response, source page, journal or API is loaded here.
const unit=encodeChapter({id:'page:4a5250d6b05c3ba8',kind:'page',title:'acknowledgements-literature-list',
 html:'<span><a href="https://example.invalid/synthetic" target="_blank">SYNTHETIC, <b>Invented Break Patterns</b>, 2001.</a></span>',targets:[]});
const raw=unit.source.replace('Invented Break Patterns','自编节拍类型').replace('⟦m2⟧','').replace('⟦/m2⟧','');
const response=JSON.stringify({translations:[raw]}),anchor='自编节拍类型',offset=raw.indexOf(anchor);
const candidate=raw.slice(0,offset)+'⟦m2⟧'+anchor+'⟦/m2⟧'+raw.slice(offset+anchor.length);
const proof={type:'reviewed-linked-title-bold-correction',requestId:'15f728d4-3ea4-4be0-b448-97bfe88843cd',unitId:unit.id,
 sourceHash:sha256(unit.source),originalResponseHash:sha256(response),expectedCandidateHash:sha256(candidate),
 markerId:'m2',parentMarkerId:'m1',sourceText:'Invented Break Patterns',translatedText:anchor,originalParentAttributes:unit.markers.m1.attributes,insertedAtUtf16:offset};
test('reviewed linked-title recovery adds only the missing bold pair and preserves the source link',()=>{
 const result=recoverReviewedLinkedTitleBold(unit,response,proof);assert.ok(result);assert.equal(result.translation,candidate);
 assert.equal(result.translation.replace('⟦m2⟧','').replace('⟦/m2⟧',''),raw);validateChapterTranslation(unit.source,result.translation);
 assert.equal(result.addedPaidRequests,0);assert.equal(result.interactiveMarkersChanged,false);assert.equal(result.translatedTextChanged,false);
 assert.ok(result.translation.includes('⟦m1⟧'));assert.ok(result.translation.includes('⟦/m1⟧'));
});
test('linked-title proof rejects other requests, sources, responses and candidates',()=>{
 for(const patch of [{requestId:'different-request'},{unitId:'page:another'},{sourceHash:'0'.repeat(64)},
  {originalResponseHash:'0'.repeat(64)},{expectedCandidateHash:'0'.repeat(64)},{markerId:'m1'},{parentMarkerId:'m0'},
  {sourceText:'Another title'},{translatedText:'不存在'},{insertedAtUtf16:offset+1},{originalParentAttributes:{href:'https://example.invalid/other',target:'_blank'}}])
 assert.equal(recoverReviewedLinkedTitleBold(unit,response,{...proof,...patch}),null,JSON.stringify(patch));
});
test('linked-title recovery rejects ambiguous text and missing outer interactive markers',()=>{
 for(const bad of [raw.replace(anchor,anchor+anchor),raw.replace('⟦m1⟧',''),raw.replace('⟦/m1⟧',''),raw.replace('⟦m0⟧',''),candidate,
  raw.replace(anchor,'⟦m2⟧'+anchor)]){
  const encoded=JSON.stringify({translations:[bad]});
  assert.equal(recoverReviewedLinkedTitleBold(unit,encoded,{...proof,originalResponseHash:sha256(encoded)}),null);
 }
});
test('linked-title recovery cannot move into another parent or change original link attributes',()=>{
 for(const change of [u=>u.markers.m1.tag='span',u=>u.markers.m2.parent='m0',u=>u.markers.m1.attributes.target='_self',
  u=>u.markers.m1.attributes.onclick='run()',u=>u.markers.m1.attributes.href='javascript:run()']){
  const changed=structuredClone(unit);change(changed);assert.equal(recoverReviewedLinkedTitleBold(changed,response,proof),null);
 }
});
