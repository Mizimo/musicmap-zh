import {syntheticHistoryFixture} from './helpers/synthetic-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {atomicJson} from '../scripts/translate.mjs';
import {prepareChapterContinuation,executeChapterContinuation,readChapterContinuationStatus,recoverChapterContinuation,
  selectContinuationUnits,CONTINUATION_RUN,PARENT_RUN} from '../lib/chapter-continuation-80.mjs';
import {recoverReviewedMissingBoldOpen,recoverReviewedMissingNestedBold} from '../lib/chapter-format-recovery-80.mjs';
const project=fileURLToPath(new URL('..',import.meta.url)),json=async f=>JSON.parse(await readFile(f)),hash=x=>createHash('sha256').update(x).digest('hex');
const parentLedger='generated/production/chapter-continuation-50pct.json';
async function fixture(t,{prepare=true}={}){
  const rootDir=await syntheticHistoryFixture(t,'50-stopped');
  if(prepare)await prepareChapterContinuation({rootDir});
  return {rootDir,workspace:join(rootDir,CONTINUATION_RUN,'workspace'),ledger:join(rootDir,'generated/production/chapter-continuation-80pct.json')};
}
const options=rootDir=>({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{}});
function response(o,{invalid=false,model,usage=true,paragraphArray=false}={}){
  const b=JSON.parse(o.body),input=JSON.parse(b.messages[1].content);assert.equal(b.model,'deepseek-v4-pro');assert.equal(b.reasoning_effort,'max');
  assert.equal(b.max_tokens,32768);assert.equal(b.stream,false);assert.deepEqual(b.thinking,{type:'enabled'});assert.equal(input.texts.length,1);
  const translated=invalid?'殘缺':input.texts[0].replace('⟦p0⟧','⟦p0⟧測試：');
  return Response.json({model:model??b.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:paragraphArray?
    translated.match(/⟦p\d+⟧[\s\S]*?⟦\/p\d+⟧/g):[translated]})}}],
    ...(usage?{usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:80,completion_tokens_details:{reasoning_tokens:30}}}:{})});
}
test('80% preparation validates and reuses 226 unique body sources with no API, archives the stopped parent',async t=>{
  const {rootDir,workspace}=await fixture(t),m=await json(join(rootDir,CONTINUATION_RUN,'manifest.json'));
  const cat=await json(join(workspace,'.cache/source/units.json')),sources=new Set(m.retained.map(x=>cat.units.find(u=>u.id===x.unitId).source));
  const selected=selectContinuationUnits(cat,sources);assert.equal(sources.size,226);assert.equal(selected.length,224);
  assert.equal(selected[0].id,'genre:hou03');assert.equal(selected.at(-1).id,'page:synthetic-stop');assert.ok(selected.every(u=>!sources.has(u.source)));
  assert.equal(m.retained.filter(x=>x.recoveryFile).length,21);assert.equal(m.supersedesUnknown.usage,null);assert.equal(m.supersedesUnknown.originalOrdinal,217);
  const before=await readFile(join(rootDir,parentLedger));const result=await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('reuse called API')});
  assert.equal(result.bodyCompleted,226);assert.equal(result.newAttempts,0);assert.equal(result.historicalAttempts,217);
  assert.deepEqual(await readFile(join(rootDir,parentLedger)),before);assert.deepEqual(await readFile(join(rootDir,CONTINUATION_RUN,'parent-snapshot/live-ledger.json')),before);
  const index=await json(join(rootDir,CONTINUATION_RUN,'parent-snapshot-index.json'));assert.ok(Object.keys(index.files).length>200);
  for(const[file,sha]of Object.entries(index.files))assert.equal(hash(await readFile(join(rootDir,file))),sha);
});
test('450 exact stop and 224 new requests; one linked replacement, immutable parent, restart cannot spend',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t);const parentBytes=await readFile(join(rootDir,parentLedger)),old=JSON.parse(parentBytes).attempts.at(-1);
  const oldJournalFile=join(rootDir,PARENT_RUN,'workspace',old.journalFile),unknownBytes=await readFile(oldJournalFile);let calls=0;
  const status=await executeChapterContinuation({...options(rootDir),fetchImpl:async(_url,o)=>{calls++;return response(o);}});
  assert.equal(calls,224);assert.equal(status.state,'target-reached');assert.equal(status.bodyCompleted,450);assert.equal(status.newAttempts,224);
  assert.equal(status.historicalAttempts,441);assert.equal(status.unusedSlots,0);assert.equal(status.uiCounted,0);
  const c=await json(ledger),first=c.attempts[0],j=await json(join(workspace,first.journalFile));
  assert.equal(first.historyOrdinal,218);assert.equal(first.supersedesRequestId,old.requestId);assert.notEqual(first.requestId,old.requestId);
  assert.equal(j.identity.supersedesRequestId,old.requestId);assert.equal(j.identity.supersedesOrdinal,217);
  assert.ok(c.attempts.slice(1).every(a=>a.supersedesRequestId===undefined));
  await prepareChapterContinuation({rootDir});await executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('225th call')});
  assert.deepEqual(await readFile(join(rootDir,parentLedger)),parentBytes);assert.deepEqual(await readFile(oldJournalFile),unknownBytes);
  assert.equal(JSON.parse(unknownBytes).rawUsage,null);assert.equal(JSON.parse(unknownBytes).type,'failed');
});
test('new unknown usage stops immediately even though one old unknown was explicitly crossed',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{calls++;return response(o,{usage:false});}}));
  let s=await readChapterContinuationStatus({rootDir});assert.equal(s.state,'review-required');assert.equal(s.bodyCompleted,226);assert.equal(s.newAttempts,1);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('unknown usage retry')}));
  await assert.rejects(()=>recoverChapterContinuation({rootDir}),{code:'RECOVERY_NOT_ALLOWED'});assert.equal(calls,1);
});
test('new network error stops without automatic retry or quota refund',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async()=>{calls++;throw Error('simulated network error');}}),{code:'API_CONNECTION_FAILED'});
  const s=await readChapterContinuationStatus({rootDir});assert.equal(s.newAttempts,1);assert.equal(s.uncertain,1);assert.equal(s.unusedSlots,223);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('network retry')}));assert.equal(calls,1);
});
test('new wrong model stops before export or a second request',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{calls++;return response(o,{model:'wrong-model'});}}),{code:'MODEL_CONFIGURATION_MISMATCH'});
  const s=await readChapterContinuationStatus({rootDir});assert.equal(s.bodyCompleted,226);assert.equal(s.newAttempts,1);assert.equal(s.state,'review-required');assert.equal(calls,1);
});
test('incomplete content consumes its slot and blocks an unreachable 450 target',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{calls++;return response(o,{invalid:true});}}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const s=await readChapterContinuationStatus({rootDir});assert.equal(s.failed,1);assert.equal(s.bodyCompleted+s.unusedSlots,449);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('failed slot replacement')}));assert.equal(calls,1);
});
test('existing deterministic local recovery retains failed journal and restarts without paying again',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t);let calls=0;
  const s=await executeChapterContinuation({...options(rootDir),shouldStop:()=>calls===1,fetchImpl:async(_u,o)=>{calls++;return response(o,{paragraphArray:true});}});
  assert.equal(s.bodyCompleted,227);assert.equal(s.newAttempts,1);assert.equal(s.locallyRecovered,1);
  const a=(await json(ledger)).attempts[0],bytes=await readFile(join(workspace,a.journalFile));assert.equal(JSON.parse(bytes).type,'failed');
  await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('recovery retry')});assert.equal(calls,1);
  assert.deepEqual(await readFile(join(workspace,a.journalFile)),bytes);
});
test('changed original unknown or retained base blocks preparation',async t=>{
  const {rootDir}=await fixture(t,{prepare:false}),originalLedger=await readFile(join(rootDir,parentLedger)),old=JSON.parse(originalLedger);
  old.attempts[0].state='failed';await atomicJson(join(rootDir,parentLedger),old);
  await assert.rejects(()=>prepareChapterContinuation({rootDir}),{code:'PRIOR_CONTINUATION_INVALID'});
  await writeFile(join(rootDir,parentLedger),originalLedger);const a=old.attempts.at(-1),file=join(rootDir,PARENT_RUN,'workspace',a.journalFile);
  const record=await json(file);record.rawUsage={prompt_tokens:0,completion_tokens:0};await atomicJson(file,record);
  await assert.rejects(()=>prepareChapterContinuation({rootDir}),{code:'PRIOR_UNKNOWN_CHANGED'});
});
test('changed frozen evidence or foreign UI exports stop before paid work',async t=>{
  const {rootDir,workspace}=await fixture(t);const file=join(workspace,'generated/shards/zh-Hans-1-of-8.json'),shard=await json(file);
  shard.translations['not in body catalog']='舊碎片';await atomicJson(file,shard);
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('foreign source')}));
  assert.equal((await readChapterContinuationStatus({rootDir})).newAttempts,0);
  await writeFile(join(workspace,'.cache/source/strings.json'),'[]');
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('changed source')}),{code:'FROZEN_INPUT_CHANGED'});
});

test('request-specific opening proof preserves failed history, rejects wrong hashes, and resumes to 450 without repayment',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t);let calls=0;
  const raw='⟦p0⟧⟦m0⟧SYNTHETIC, Ada，《虚构章节指南》⟦/m1⟧，Fixture Press，测试城，2004.⟦/m0⟧⟦/p0⟧';
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{
    calls++;if(calls!==134)return response(o);
    return Response.json({model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[raw]})}}],
      usage:{prompt_tokens:600,completion_tokens:1181,total_tokens:1781,prompt_cache_hit_tokens:384,prompt_cache_miss_tokens:216,
        completion_tokens_details:{reasoning_tokens:1117}}});
  }}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const c=await json(ledger),a=c.attempts.at(-1),journalBytes=await readFile(join(workspace,a.journalFile)),record=JSON.parse(journalBytes);
  assert.equal(a.unitId,'page:synthetic-open');assert.equal(calls,134);assert.equal(record.type,'failed');
  const cat=await json(join(workspace,'.cache/source/units.json')),unit=cat.units.find(u=>u.id===a.unitId);
  const proof={type:'reviewed-missing-bold-open-correction',markerId:'m1',parentMarkerId:'m0',
    sourceText:'Invented Chapter Guide',translatedText:'《虚构章节指南》',requestId:a.requestId,unitId:a.unitId,
    sourceHash:hash(unit.source),originalResponseHash:hash(record.responseText),originalJournalHash:hash(journalBytes)};
  const candidate=recoverReviewedMissingBoldOpen(unit,record.responseText,proof);assert.ok(candidate);
  proof.expectedCandidateHash=hash(candidate.translation);
  const proofFile=`data/reviewed-opening-${a.requestId}.json`,manifestFile=join(rootDir,CONTINUATION_RUN,'manifest.json');
  async function register(value){
    await atomicJson(join(workspace,proofFile),value);const sha256=hash(await readFile(join(workspace,proofFile)));
    const m=await json(manifestFile);m.inputs[proofFile]=sha256;m.reviewedFormatCorrections=[{requestId:a.requestId,file:proofFile,sha256}];
    await atomicJson(manifestFile,m);const updated=await json(ledger);updated.manifestHash=hash(await readFile(manifestFile));await atomicJson(ledger,updated);
  }
  for(const [field,code] of [['originalResponseHash','REVIEWED_CORRECTION_MISMATCH'],['originalJournalHash','REVIEWED_CORRECTION_MISMATCH'],
    ['sourceHash','REVIEWED_CORRECTION_MISMATCH'],['expectedCandidateHash','REVIEWED_CORRECTION_INVALID']]){
    await register({...proof,[field]:'0'.repeat(64)});await assert.rejects(()=>recoverChapterContinuation({rootDir}),{code});
    assert.equal(calls,134);assert.deepEqual(await readFile(join(workspace,a.journalFile)),journalBytes);
  }
  await register(proof);await recoverChapterContinuation({rootDir});
  const recovered=await readChapterContinuationStatus({rootDir});assert.equal(recovered.bodyCompleted,360);assert.equal(recovered.newAttempts,134);
  await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('paid replay of recovered request')});
  const done=await executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{calls++;return response(o);}});
  assert.equal(calls,224);assert.equal(done.bodyCompleted,450);assert.equal(done.historicalAttempts,441);assert.equal(done.state,'target-reached');
  await executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('225th paid request')});
  assert.deepEqual(await readFile(join(workspace,a.journalFile)),journalBytes);
  const final=(await json(ledger)).attempts[133];assert.equal(final.originalFailure,'INVALID_CHAPTER_STRUCTURE');assert.ok(final.recoveryFile);
});

test('separate nested-pair proof cannot reuse opening proof and resumes without repaying a failed journal',async t=>{
  const {rootDir,workspace,ledger}=await fixture(t);let calls=0;
  const raw='⟦p0⟧⟦m0⟧SYNTHETIC, Bo，《虚构历史读本》，Fixture Press，测试城，2007年。⟦/m0⟧⟦/p0⟧';
  await assert.rejects(()=>executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{
    calls++;if(calls!==147)return response(o);
    return Response.json({model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[raw]})}}],
      usage:{prompt_tokens:594,completion_tokens:797,total_tokens:1391,prompt_cache_hit_tokens:384,prompt_cache_miss_tokens:210,
        completion_tokens_details:{reasoning_tokens:735}}});
  }}),{code:'INVALID_CHAPTER_STRUCTURE'});
  const c=await json(ledger),a=c.attempts.at(-1),bytes=await readFile(join(workspace,a.journalFile)),record=JSON.parse(bytes);
  assert.equal(a.unitId,'page:synthetic-nested');assert.equal(calls,147);assert.equal(record.type,'failed');
  const cat=await json(join(workspace,'.cache/source/units.json')),unit=cat.units.find(u=>u.id===a.unitId);
  const proof={type:'reviewed-missing-nested-bold-correction',markerId:'m1',parentMarkerId:'m0',
    sourceText:'Invented History Reader',translatedText:'《虚构历史读本》',requestId:a.requestId,unitId:a.unitId,
    sourceHash:hash(unit.source),originalResponseHash:hash(record.responseText),originalJournalHash:hash(bytes)};
  assert.equal(recoverReviewedMissingBoldOpen(unit,record.responseText,{...proof,type:'reviewed-missing-bold-open-correction'}),null);
  const candidate=recoverReviewedMissingNestedBold(unit,record.responseText,proof);assert.ok(candidate);proof.expectedCandidateHash=hash(candidate.translation);
  const file=`data/reviewed-nested-${a.requestId}.json`,mf=join(rootDir,CONTINUATION_RUN,'manifest.json');
  async function register(value){await atomicJson(join(workspace,file),value);const sha256=hash(await readFile(join(workspace,file))),m=await json(mf);
    m.inputs[file]=sha256;m.reviewedFormatCorrections=[{requestId:a.requestId,file,sha256}];await atomicJson(mf,m);
    const current=await json(ledger);current.manifestHash=hash(await readFile(mf));await atomicJson(ledger,current);}
  await register({...proof,requestId:'unrelated-request'});await assert.rejects(()=>recoverChapterContinuation({rootDir}),{code:'REVIEWED_CORRECTION_MISMATCH'});
  await register({...proof,expectedCandidateHash:'0'.repeat(64)});await assert.rejects(()=>recoverChapterContinuation({rootDir}),{code:'REVIEWED_CORRECTION_INVALID'});
  await register(proof);await recoverChapterContinuation({rootDir});assert.equal((await readChapterContinuationStatus({rootDir})).bodyCompleted,373);
  await executeChapterContinuation({...options(rootDir),shouldStop:()=>true,fetchImpl:()=>assert.fail('paid nested-title recovery')});
  const done=await executeChapterContinuation({...options(rootDir),fetchImpl:async(_u,o)=>{calls++;return response(o);}});
  assert.equal(calls,224);assert.equal(done.bodyCompleted,450);assert.equal(done.historicalAttempts,441);assert.equal(done.state,'target-reached');
  await executeChapterContinuation({...options(rootDir),fetchImpl:()=>assert.fail('extra paid call after 450')});
  assert.deepEqual(await readFile(join(workspace,a.journalFile)),bytes);assert.equal((await json(ledger)).attempts[146].originalFailure,'INVALID_CHAPTER_STRUCTURE');
});
