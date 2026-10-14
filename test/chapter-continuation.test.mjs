import {syntheticHistoryFixture} from './helpers/synthetic-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicJson } from '../scripts/translate.mjs';
import { PILOT_RUN } from '../lib/chapter-pilot.mjs';
import { prepareChapterContinuation, executeChapterContinuation, readChapterContinuationStatus,
  recoverChapterContinuation, selectContinuationUnits, CONTINUATION_RUN } from '../lib/chapter-continuation.mjs';
import { assertLegacyTranslationAllowed } from '../lib/translation-retirement.mjs';
import { recoverChapterFormat, recoverReviewedDuplicateBold, recoverReviewedMissingBold, recoverReviewedMissingBoldPair, recoverReviewedParagraphBoundaries } from '../lib/chapter-format-recovery.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const rootDir=await syntheticHistoryFixture(t,'pilot-completed');
  await prepareChapterContinuation({rootDir});
  return {rootDir,workspace:join(rootDir,CONTINUATION_RUN,'workspace'),ledger:join(rootDir,'generated/production/chapter-continuation-50pct.json')};
}
function response(options, invalid=false, override={}) {
  const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);
  assert.equal(body.model,'deepseek-v4-pro');assert.equal(body.reasoning_effort,'max');assert.equal(body.max_tokens,32768);
  assert.equal(body.stream,false);assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(input.texts.length,1);
  assert.ok(input.texts[0].startsWith('⟦p0⟧'));
  return Response.json({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[invalid?'殘缺':input.texts[0].replace('⟦p0⟧','⟦p0⟧測試：')]})}}],
    usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:80,completion_tokens_details:{reasoning_tokens:30}},...override});
}
const options = rootDir => ({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{}});

test('catalog order is deduplicated; ten prior chapters count, UI keys never count', async t=>{
  const {rootDir,workspace}=await fixture(t);
  const m=await json(join(rootDir,CONTINUATION_RUN,'manifest.json')), c=await json(join(workspace,'.cache/source/units.json'));
  const retained=new Set(m.retained.map(r=>c.units.find(u=>u.id===r.unitId).source));
  const selected=selectContinuationUnits(c,retained);
  assert.equal(selected.length,271);assert.equal(new Set(selected.map(u=>u.source)).size,271);
  assert.equal(selected[0].id,'genre:inl');assert.equal(selected[1].id,'genre:rnr');
  assert.ok(selected.every(u=>!retained.has(u.source)));assert.equal(c.source.length-new Set(c.units.map(u=>u.source)).size,1338);
  await assert.rejects(()=>assertLegacyTranslationAllowed(workspace),{code:'TRANSLATION_RETIRED'});
});

test('exact 281/562 stop: at most 271 new calls, immutable pilot, reprepare/restart buys nothing',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  const prior=await readFile(join(rootDir,'generated/production/chapter-pilot.json'),'utf8');
  const result=await executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{calls++;return response(o);}});
  assert.equal(result.state,'target-reached');assert.equal(result.bodyCompleted,281);assert.equal(result.newAttempts,271);assert.equal(calls,271);
  assert.equal(result.uiCounted,0);assert.equal(result.unusedSlots,0);
  await prepareChapterContinuation({rootDir});
  const again=await executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('272nd request')});
  assert.equal(again.bodyCompleted,281);assert.equal(await readFile(join(rootDir,'generated/production/chapter-pilot.json'),'utf8'),prior);
});

test('unrecoverable format failure consumes a slot and stops when exact target is unreachable',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>response(o,++calls===1)}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const result=await readChapterContinuationStatus({rootDir});
  assert.equal(result.state,'review-required');assert.equal(result.bodyCompleted,10);assert.equal(result.failed,1);assert.equal(calls,1);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('replacement request')}),{code:'UNRECOVERABLE_FORMAT_FAILURE'});
});

test('unknown usage/model stops immediately and persists across restarts',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{calls++;return response(o,false,{model:'other-model'});}}),{code:'MODEL_CONFIGURATION_MISMATCH'});
  const status=await readChapterContinuationStatus({rootDir});assert.equal(status.state,'review-required');assert.equal(status.newAttempts,1);assert.equal(status.bodyCompleted,10);assert.equal(calls,1);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('unknown retry')}),{code:'UNRESOLVED_ATTEMPT'});
});

test('completed journal recovers export without paid retry; review-required persists',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{calls++;return response(o);},afterJournal:async()=>{throw new Error('export failed');}}),/export failed/);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('retry')}),/Review-required/);
  const status=await readChapterContinuationStatus({rootDir});assert.equal(status.bodyCompleted,11);assert.equal(status.newAttempts,1);assert.equal(calls,1);
});

test('single concurrency: stop finishes the current chapter and retains next slot',async t=>{
  const {rootDir}=await fixture(t);let enter,finish,calls=0;
  const entered=new Promise(r=>enter=r),pending=new Promise(r=>finish=r);
  const running=executeChapterContinuation({...options(rootDir),shouldStop:()=>calls===1,
    fetchImpl:async(_url,o)=>{calls++;enter();await pending;return response(o);}});
  await entered;
  await assert.rejects(()=>executeChapterContinuation(options(rootDir)),/Translation lock exists/);
  finish();const result=await running;assert.equal(result.state,'paused');assert.equal(result.bodyCompleted,11);assert.equal(result.newAttempts,1);
});

test('changed source and foreign UI/fragment exports block before any new call',async t=>{
  const {rootDir,workspace}=await fixture(t);
  const file=join(workspace,'generated/shards/zh-Hans-1-of-8.json'),shard=await json(file);
  shard.translations['not in frozen catalog']='舊碎片';await atomicJson(file,shard);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('foreign entry')}));
  assert.equal((await readChapterContinuationStatus({rootDir})).newAttempts,0);
  await writeFile(join(workspace,'.cache/source/strings.json'),'[]');
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('changed source')}),{code:'FROZEN_INPUT_CHANGED'});
});

test('single-paragraph envelope recovery changes no translated text or inline markers',()=>{
  const source='⟦p0⟧One ⟦m0⟧word⟦/m0⟧.⟦/p0⟧',raw='一個⟦m0⟧詞語⟦/m0⟧。';
  const result=recoverChapterFormat(source,JSON.stringify({translations:[raw]}));
  assert.equal(result.translation,'⟦p0⟧'+raw+'⟦/p0⟧');assert.equal(result.translatedTextChanged,false);assert.equal(result.addedPaidRequests,0);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:['殘缺、沒有連結']})),null);
});

test('paragraph arrays recover only when complete, in order, and unchanged',()=>{
  const source='⟦p0⟧First.⟦/p0⟧\n⟦p1⟧Second ⟦m0⟧link⟦/m0⟧.⟦/p1⟧';
  const items=['⟦p0⟧第一段。⟦/p0⟧','⟦p1⟧第二段⟦m0⟧連結⟦/m0⟧。⟦/p1⟧'];
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:items})).translation,items.join('\n'));
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[items[0]]})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[...items].reverse()})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[...items,'額外文字']})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:items,extra:'未處理欄位'})),null);
});

test('only missing outer chapter boundaries recover; internal boundaries are never guessed',()=>{
  const source='⟦p0⟧One ⟦m0⟧link⟦/m0⟧.⟦/p0⟧⟦p1⟧Two ⟦m1⟧links⟦/m1⟧.⟦/p1⟧';
  const full='⟦p0⟧第一段⟦m0⟧連結⟦/m0⟧。⟦/p0⟧⟦p1⟧第二段⟦m1⟧連結⟦/m1⟧。⟦/p1⟧';
  for(const raw of [full.slice(4),full.slice(0,-5),full.slice(4,-5)]){
    const result=recoverChapterFormat(source,JSON.stringify({translations:[raw]}));
    assert.equal(result.translation,full);assert.equal(result.translatedTextChanged,false);
  }
  for(const raw of [full.replace('⟦/p0⟧',''),full.replace('⟦p1⟧',''),full.replace('⟦m1⟧','')]){
    assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[raw]})),null);
  }
});

test('explicit paragraph breaks need exact count and every source marker in its original paragraph',()=>{
  const source='⟦p0⟧One ⟦m0⟧link⟦/m0⟧.⟦/p0⟧⟦p1⟧Two ⟦m1⟧links⟦/m1⟧.⟦/p1⟧';
  const parts=['第一段⟦m0⟧連結⟦/m0⟧。','第二段⟦m1⟧連結⟦/m1⟧。'];
  const expected=parts.map((p,i)=>`⟦p${i}⟧${p}⟦/p${i}⟧`).join('\n');
  for(const separator of ['\n','\\n']){
    const result=recoverChapterFormat(source,JSON.stringify({translations:[parts.join(separator)]}));
    assert.equal(result.translation,expected);assert.equal(result.explicitSeparator,separator);assert.equal(result.addedPaidRequests,0);
  }
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[parts.join('')]})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[[...parts].reverse().join('\\n')]})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[parts.join('\\n')+'\\n額外一段']})),null);
  const noAnchors='⟦p0⟧First.⟦/p0⟧⟦p1⟧Second.⟦/p1⟧';
  assert.equal(recoverChapterFormat(noAnchors,JSON.stringify({translations:['第一段\\n第二段']})),null);
});

test('unwrapped paragraph arrays preserve all item text and require source-owned inline anchors',()=>{
  const source='⟦p0⟧One ⟦m0⟧link⟦/m0⟧.⟦/p0⟧⟦p1⟧Two ⟦m1⟧links⟦/m1⟧.⟦/p1⟧';
  const parts=['第一段⟦m0⟧連結⟦/m0⟧。','第二段⟦m1⟧連結⟦/m1⟧。'];
  const expected=parts.map((p,i)=>`⟦p${i}⟧${p}⟦/p${i}⟧`).join('\n');
  for(const items of [parts,[parts[0]+'⟦/p0⟧','⟦p1⟧'+parts[1]]]){
    const result=recoverChapterFormat(source,JSON.stringify({translations:items}));assert.equal(result.translation,expected);assert.equal(result.translatedTextChanged,false);
  }
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[...parts].reverse()})),null);
  assert.equal(recoverChapterFormat(source,JSON.stringify({translations:[parts[0],parts[0]]})),null);
  assert.equal(recoverChapterFormat('⟦p0⟧One.⟦/p0⟧⟦p1⟧Two.⟦/p1⟧',JSON.stringify({translations:['一','二']})),null);
});

test('literal JSON line breaks are escaped without altering any decoded text or markers',()=>{
  const source='⟦p0⟧A ⟦m0⟧new⟦/m0⟧ genre.⟦/p0⟧';
  const translation='⟦p0⟧一\n\n种⟦m0⟧新⟦/m0⟧类型。⟦/p0⟧';
  const raw='{"translations":["'+translation+'"]}';
  assert.throws(()=>JSON.parse(raw));
  const fixed=recoverChapterFormat(source,raw);assert.equal(fixed.translation,translation);
  assert.equal(fixed.escapedLineBreaks,2);assert.equal(fixed.translatedTextChanged,false);
  assert.equal(recoverChapterFormat(source,raw.replace('⟦m0⟧','')),null);
  assert.equal(recoverChapterFormat(source,raw.replace('新','新"')),null);
  assert.equal(recoverChapterFormat(source,raw.replace('\n\n','\t')),null);
});

test('duplicate bold removal requires an explicit occurrence choice and cannot remove links or text',()=>{
  const unit={source:'⟦p0⟧Lo-Fi. ⟦m0⟧Lo-Fi⟦/m0⟧ means low fidelity.⟦/p0⟧',paragraphs:[{id:'p0'}],markers:{m0:{tag:'b',attributes:{},parent:null,paragraph:'p0'}}};
  const raw='⟦p0⟧⟦m0⟧低保真⟦/m0⟧。⟦m0⟧低保真⟦/m0⟧就是低保真音質。⟦/p0⟧',response=JSON.stringify({translations:[raw]});
  const correction={type:'reviewed-format-correction',markerId:'m0',expectedOccurrences:2,removeOccurrence:1};
  assert.equal(recoverChapterFormat(unit.source,response),null);
  const fixed=recoverReviewedDuplicateBold(unit,response,correction);
  assert.equal(fixed.translation,'⟦p0⟧低保真。⟦m0⟧低保真⟦/m0⟧就是低保真音質。⟦/p0⟧');assert.equal(fixed.translatedTextChanged,false);
  assert.equal(recoverReviewedDuplicateBold(unit,response,{}),null);
  assert.equal(recoverReviewedDuplicateBold({...unit,markers:{m0:{tag:'a',attributes:{href:'/link'},parent:null}}},response,correction),null);
  assert.equal(recoverReviewedDuplicateBold(unit,JSON.stringify({translations:[raw.replace('⟦m0⟧低保真⟦/m0⟧。','⟦m0⟧不同文字⟦/m0⟧。')]}),correction),null);
});

test('reviewed missing bold preserves every character and requires one source-matched anchor',()=>{
  const unit={source:'⟦p0⟧Not ⟦m0⟧danceable⟦/m0⟧.⟦/p0⟧',paragraphs:[{id:'p0'}],markers:{m0:{tag:'b',attributes:{},parent:null,paragraph:'p0'}}};
  const response=JSON.stringify({translations:['⟦p0⟧不适合跳舞。⟦/p0⟧']});
  const proof={type:'reviewed-missing-bold-correction',markerId:'m0',sourceText:'danceable',translatedText:'适合跳舞'};
  assert.equal(recoverChapterFormat(unit.source,response),null);
  assert.equal(recoverReviewedMissingBold(unit,response,proof).translation,'⟦p0⟧不⟦m0⟧适合跳舞⟦/m0⟧。⟦/p0⟧');
  assert.equal(recoverReviewedMissingBold(unit,response,{...proof,sourceText:'daring'}),null);
  assert.equal(recoverReviewedMissingBold(unit,response,{...proof,translatedText:'没有'}),null);
  assert.equal(recoverReviewedMissingBold(unit,JSON.stringify({translations:['⟦p0⟧适合跳舞还是适合跳舞。⟦/p0⟧']}),proof),null);
  assert.equal(recoverReviewedMissingBold({...unit,markers:{m0:{tag:'a',attributes:{href:'/a'},parent:null,paragraph:'p0'}}},response,proof),null);
  assert.equal(recoverReviewedMissingBold({...unit,markers:{m0:{...unit.markers.m0,paragraph:'p1'}}},response,proof),null);
  assert.equal(recoverReviewedMissingBold(unit,JSON.stringify({translations:['⟦p0⟧不⟦m0⟧适合跳舞。⟦/p0⟧']}),proof),null);
});

test('two missing bold markers require two unique reviewed anchors and preserve reordered Chinese text',()=>{
  const unit={source:'⟦p0⟧A ⟦m0⟧decline⟦/m0⟧ due to ⟦m1⟧negative publicity⟦/m1⟧.⟦/p0⟧',paragraphs:[{id:'p0'}],
    markers:Object.fromEntries(['m0','m1'].map(id=>[id,{tag:'b',attributes:{},parent:null,paragraph:'p0'}]))};
  const raw='⟦p0⟧由于负面宣传，开始衰落。⟦/p0⟧',response=JSON.stringify({translations:[raw]});
  const proof={type:'reviewed-missing-bold-pair-correction',markers:[{markerId:'m0',sourceText:'decline',translatedText:'衰落'},
    {markerId:'m1',sourceText:'negative publicity',translatedText:'负面宣传'}]};
  const fixed=recoverReviewedMissingBoldPair(unit,response,proof);assert.ok(fixed);
  assert.equal(fixed.translation,'⟦p0⟧由于⟦m1⟧负面宣传⟦/m1⟧，开始⟦m0⟧衰落⟦/m0⟧。⟦/p0⟧');
  assert.equal(fixed.translation.replace(/⟦\/?m[01]⟧/g,''),raw);assert.equal(fixed.translatedTextChanged,false);
  assert.equal(recoverReviewedMissingBoldPair(unit,response,{...proof,markers:proof.markers.slice(0,1)}),null);
  assert.equal(recoverReviewedMissingBoldPair(unit,response,{...proof,markers:[proof.markers[0],proof.markers[0]]}),null);
  assert.equal(recoverReviewedMissingBoldPair(unit,response,{...proof,markers:[proof.markers[0],{...proof.markers[1],sourceText:'wrong'}]}),null);
  assert.equal(recoverReviewedMissingBoldPair(unit,JSON.stringify({translations:[raw.replace('衰落','衰落衰落')]}),proof),null);
  assert.equal(recoverReviewedMissingBoldPair({...unit,markers:{...unit.markers,m1:{...unit.markers.m1,tag:'a'}}},response,proof),null);
  assert.equal(recoverReviewedMissingBoldPair({...unit,source:unit.source.replace('.',' ⟦m2⟧more⟦/m2⟧.')},response,proof),null);
});

test('reviewed paragraph starts preserve all text and must match original marker ownership',()=>{
  const unit={source:'⟦p0⟧First ⟦m0⟧one⟦/m0⟧.⟦/p0⟧\n⟦p1⟧Second ⟦m1⟧two⟦/m1⟧.⟦/p1⟧'};
  const raw='第一段⟦m0⟧一⟦/m0⟧。 第二段⟦m1⟧二⟦/m1⟧。',response=JSON.stringify({translations:[raw]});
  const proof={type:'reviewed-paragraph-boundary-correction',paragraphStarts:[{paragraph:'p0',translatedPrefix:'第一段'},{paragraph:'p1',translatedPrefix:'第二段'}]};
  assert.equal(recoverChapterFormat(unit.source,response),null);
  const fixed=recoverReviewedParagraphBoundaries(unit,response,proof);assert.equal(fixed.translation.replace(/⟦\/?p\d+⟧/g,''),raw);
  assert.equal(fixed.translatedTextChanged,false);assert.equal(fixed.inlineMarkersChanged,false);
  assert.equal(recoverReviewedParagraphBoundaries(unit,response,{...proof,paragraphStarts:[proof.paragraphStarts[0],{paragraph:'p1',translatedPrefix:'⟦m0⟧'}]}),null);
  assert.equal(recoverReviewedParagraphBoundaries(unit,JSON.stringify({translations:[raw+'第二段']}),proof),null);
  assert.equal(recoverReviewedParagraphBoundaries(unit,JSON.stringify({translations:['⟦p0⟧'+raw]}),proof),null);
  assert.equal(recoverReviewedParagraphBoundaries({source:'⟦p0⟧First.⟦/p0⟧⟦p1⟧Second.⟦/p1⟧'},response,proof),null);
});

test('reviewed duplicate correction is bound to one paid journal and immutable proof',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t),hash=value=>createHash('sha256').update(value).digest('hex');
  const manifestFile=join(rootDir,CONTINUATION_RUN,'manifest.json'),manifest=await json(manifestFile);
  const ordinal=manifest.selected.findIndex(x=>x.unitId==='genre:alt07')+1;assert.ok(ordinal>0);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{
    const payload=await response(o).json();if(++calls===ordinal){
      const content=JSON.parse(payload.choices[0].message.content);
      content.translations[0]=content.translations[0].replace('unmarked fictional Lo-Fi','unmarked fictional ⟦m11⟧Lo-Fi⟦/m11⟧');
      payload.choices[0].message.content=JSON.stringify(content);
    }return Response.json(payload);
  }}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const control=await json(ledger),attempt=control.attempts.at(-1),bytes=await readFile(join(workspace,attempt.journalFile)),record=JSON.parse(bytes);
  const registry=await json(join(workspace,'.cache/source/units.json')),unit=registry.units.find(u=>u.id===attempt.unitId);
  const proof={type:'reviewed-format-correction',requestId:record.requestId,unitId:unit.id,sourceHash:hash(unit.source),
    originalJournalHash:hash(bytes),originalResponseHash:hash(record.responseText),markerId:'m11',expectedOccurrences:2,removeOccurrence:1};
  const candidate=recoverReviewedDuplicateBold(unit,record.responseText,proof);assert.ok(candidate);
  proof.expectedCandidateHash=hash(candidate.translation);
  const file=`generated/reviewed-format-corrections/${record.requestId}.json`;await atomicJson(join(workspace,file),proof);
  const sha256=hash(await readFile(join(workspace,file)));manifest.inputs[file]=sha256;
  manifest.reviewedFormatCorrections=[{requestId:record.requestId,file,sha256}];await atomicJson(manifestFile,manifest);
  control.manifestHash=hash(await readFile(manifestFile));await atomicJson(ledger,control);
  const status=await recoverChapterContinuation({rootDir});assert.equal(status.bodyCompleted,ordinal+10);assert.equal(status.newAttempts,ordinal);assert.equal(status.locallyRecovered,1);
  assert.equal(calls,ordinal);assert.deepEqual(await readFile(join(workspace,attempt.journalFile)),bytes);
  proof.removeOccurrence=2;await atomicJson(join(workspace,file),proof);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('unreviewed proof triggered paid call')}),{code:'FROZEN_INPUT_CHANGED'});
});

test('two-marker proof recovers one failed attempt without a paid retry and survives restart',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t),hash=value=>createHash('sha256').update(value).digest('hex');
  const manifestFile=join(rootDir,CONTINUATION_RUN,'manifest.json'),manifest=await json(manifestFile);
  const ordinal=manifest.selected.findIndex(x=>x.unitId==='genre:hct10')+1;assert.equal(ordinal,206);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{
    const payload=await response(o).json();if(++calls===ordinal){const content=JSON.parse(payload.choices[0].message.content);
      content.translations[0]=content.translations[0]
        .replace('⟦m0⟧decline⟦/m0⟧','⟦m0⟧衰落⟦/m0⟧').replace('⟦m1⟧negative publicity⟦/m1⟧','⟦m1⟧负面宣传⟦/m1⟧')
        .replace(/⟦\/?m[01]⟧/g,'');payload.choices[0].message.content=JSON.stringify(content);
    }return Response.json(payload);
  }}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const control=await json(ledger),attempt=control.attempts.at(-1),bytes=await readFile(join(workspace,attempt.journalFile)),record=JSON.parse(bytes);
  const registry=await json(join(workspace,'.cache/source/units.json')),unit=registry.units.find(u=>u.id===attempt.unitId);
  const proof={type:'reviewed-missing-bold-pair-correction',requestId:record.requestId,unitId:unit.id,sourceHash:hash(unit.source),
    originalJournalHash:hash(bytes),originalResponseHash:hash(record.responseText),markers:[
      {markerId:'m0',sourceText:'decline',translatedText:'衰落'},
      {markerId:'m1',sourceText:'negative publicity',translatedText:'负面宣传'}]};
  const candidate=recoverReviewedMissingBoldPair(unit,record.responseText,proof);assert.ok(candidate);proof.expectedCandidateHash=hash(candidate.translation);
  const file=`generated/reviewed-format-corrections/${record.requestId}.json`;await atomicJson(join(workspace,file),proof);
  const sha256=hash(await readFile(join(workspace,file)));manifest.inputs[file]=sha256;manifest.reviewedFormatCorrections=[{requestId:record.requestId,file,sha256}];
  await atomicJson(manifestFile,manifest);control.manifestHash=hash(await readFile(manifestFile));await atomicJson(ledger,control);
  const status=await recoverChapterContinuation({rootDir});assert.equal(status.bodyCompleted,216);assert.equal(status.newAttempts,206);assert.equal(status.locallyRecovered,1);
  await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('restart bought a request')});
  assert.equal(calls,206);assert.deepEqual(await readFile(join(workspace,attempt.journalFile)),bytes);assert.equal(record.type,'failed');
  proof.markers[0].translatedText='wrong';await atomicJson(join(workspace,file),proof);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('tampered proof bought a request')}),{code:'FROZEN_INPUT_CHANGED'});
});

test('local recovery preserves the failed paid journal and restarts without another request',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t);let calls=0;
  const result=await executeChapterContinuation({...options(rootDir),shouldStop:()=>calls>=1,fetchImpl:async(_url,o)=>{
    calls++;const payload=await response(o).json();const full=JSON.parse(payload.choices[0].message.content).translations[0];
    const parts=full.match(/⟦p\d+⟧[\s\S]*?⟦\/p\d+⟧/g);assert.ok(parts.length>1);
    payload.choices[0].message.content=JSON.stringify({translations:parts});return Response.json(payload);
  }});
  assert.equal(result.bodyCompleted,11);assert.equal(result.locallyRecovered,1);assert.equal(result.newAttempts,1);assert.equal(calls,1);
  const attempt=(await json(ledger)).attempts[0];assert.equal((await json(join(workspace,attempt.journalFile))).type,'failed');
  const recovery=await json(join(workspace,attempt.recoveryFile));assert.equal(recovery.type,'local-format-recovery');assert.equal(recovery.addedPaidRequests,0);
  const raw=await readFile(join(workspace,attempt.journalFile),'utf8');
  await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('recovery bought another call')});
  assert.equal(await readFile(join(workspace,attempt.journalFile),'utf8'),raw);
});
