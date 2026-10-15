import { createHash } from 'node:crypto';
import { validateChapterTranslation } from '../public/chapter-renderer.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');

// A single reviewed paid response: restore only a noninteractive bold title
// inside its intact source link. No link, attribute, prose or validator changes.
export function recoverReviewedLinkedTitleBold(unit,responseText,proof){
  try{
    if(proof?.type!=='reviewed-linked-title-bold-correction'
      ||proof.requestId!=='15f728d4-3ea4-4be0-b448-97bfe88843cd'
      ||unit.id!=='page:4a5250d6b05c3ba8'||proof.unitId!==unit.id
      ||unit.kind!=='page'||unit.title!=='acknowledgements-literature-list'||unit.paragraphs.length!==1
      ||proof.sourceHash!==sha256(unit.source)||proof.originalResponseHash!==sha256(responseText)
      ||proof.markerId!=='m2'||proof.parentMarkerId!=='m1'
      ||!proof.sourceText||!proof.translatedText||/[⟦⟧]/.test(proof.translatedText))return null;
    const {m0,m1,m2}=unit.markers;
    if(Object.keys(unit.markers).sort().join(',')!=='m0,m1,m2'
      ||m0.tag!=='span'||m0.parent!==null||Object.keys(m0.attributes).length
      ||m1.tag!=='a'||m1.parent!=='m0'||m1.paragraph!==m0.paragraph
      ||Object.keys(m1.attributes).sort().join(',')!=='href,target'||m1.attributes.target!=='_blank'
      ||!/^https?:\/\//.test(m1.attributes.href)
      ||JSON.stringify(m1.attributes)!==JSON.stringify(proof.originalParentAttributes)
      ||m2.tag!=='b'||m2.parent!=='m1'||m2.paragraph!==m1.paragraph||Object.keys(m2.attributes).length
      ||!unit.source.includes(`⟦m2⟧${proof.sourceText}⟦/m2⟧`))return null;
    const payload=JSON.parse(responseText);
    if(Object.keys(payload).length!==1||payload.translations?.length!==1||typeof payload.translations[0]!=='string')return null;
    const raw=payload.translations[0],open='⟦m2⟧',close='⟦/m2⟧',text=proof.translatedText;
    if(raw.includes(open)||raw.includes(close)||raw.split(text).length!==2)return null;
    const offset=raw.indexOf(text);if(offset!==proof.insertedAtUtf16)return null;
    const translation=raw.slice(0,offset)+open+text+close+raw.slice(offset+text.length);
    if(translation.replace(open,'').replace(close,'')!==raw||sha256(translation)!==proof.expectedCandidateHash)return null;
    validateChapterTranslation(unit.source,translation);
    return {kind:'reviewed-linked-title-bold',translation,responseItems:1,sourceParagraphs:1,
      translatedTextChanged:false,inlineMarkersChanged:true,interactiveMarkersChanged:false,addedPaidRequests:0,
      restoredMarker:{markerId:'m2',parentMarkerId:'m1',sourceText:proof.sourceText,translatedText:text,insertedAtUtf16:offset}};
  }catch{return null;}
}
