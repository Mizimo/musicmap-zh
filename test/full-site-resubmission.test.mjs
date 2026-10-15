import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeChapter,hashUnitCatalog} from '../lib/chapter-units.mjs';
import {sha256,treeHashes,knownUsage,PARENT_RUN} from '../lib/full-site-parent.mjs';
import {FULL_PROGRAM,FULL_ID,FULL_RUN,FULL_LEDGER,createFullSitePlan,nextFullJob,validateFullLedger,
  executeFullSite,recoverFullSite,readFullSiteStatus,validateLabel,applyFullSiteReplacement,verifyReviewedFullUnknown,registerFullSiteReview,registerFullSiteLabelDeferral} from '../lib/full-site.mjs';
import {PILOT_CONFIG} from '../lib/chapter-pilot.mjs';
import {CHAPTER_PROMPT_TEMPLATE_HASH,TRANSLATION_PROMPT_TEMPLATE_HASH,createTranslator} from '../lib/translator.mjs';
import {dictionary} from '../public/dictionary.js';
import {TERMINOLOGY,TERMINOLOGY_HASH} from '../lib/terminology.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const units=Array.from({length:562},(_,i)=>encodeChapter({id:`page:test${i}`,kind:'page',title:'Test',html:`Whole paragraph ${i}.`,targets:[]}));
const known=[...new Set([...Object.keys(dictionary),...TERMINOLOGY.terms.flatMap(t=>t.english)])].slice(0,164);
const labels=[...known,...Array.from({length:1174},(_,i)=>`Independent label ${i}`)];
const source=[...units.map(u=>u.source),...labels],catalog={schemaVersion:1,protocol:'musicmap-chapters-v1',snapshotHash:'test',source,sourceHash:sha256(JSON.stringify(source)),units:[...units,...units.slice(0,10)],stats:{}};
catalog.catalogHash=hashUnitCatalog(catalog);
const retained=units.slice(0,450).map(u=>({source:u.source,unitId:u.id,translation:u.source,translationHash:sha256(u.source)}));
const plan=createFullSitePlan(catalog,new Set(retained.map(r=>r.source)));
function pureFixture(){return {manifest:{plan},ledger:{id:FULL_ID,run:FULL_RUN,maxAttempts:plan.counts.maxAttempts,target:1900,priorAttempts:441,state:'prepared',attempts:[]}};}
async function stagedFixture(t){
 const project=await mkdtemp(join(tmpdir(),'mm-full-'));t.after(()=>rm(project,{recursive:true,force:true}));
 const run=join(project,FULL_RUN),ws=join(run,'workspace');
 for(const file of FULL_PROGRAM){for(const base of [project,ws]){await mkdir(dirname(join(base,file)),{recursive:true});await cp(join(root,file),join(base,file));}}
 const program=Object.fromEntries(await Promise.all(FULL_PROGRAM.map(async p=>[p,sha256(await readFile(join(project,p)))])));
 const save=async(p,j)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(j));};
 await save(join(ws,'.cache/source/units.json'),catalog);await save(join(ws,'.cache/source/strings.json'),source);
 for(let i=1;i<=8;i++)await save(join(ws,`generated/shards/zh-Hans-${i}-of-8.json`),{sourceHash:catalog.sourceHash,language:'zh-Hans',shard:{index:i,count:8},translations:{}});
 // Initial exports use the same original partitioning, without any API calls.
 const {shardForText}=await import('../scripts/translate.mjs');
 for(const entry of [...retained,...plan.prefill]){const file=join(ws,`generated/shards/zh-Hans-${shardForText(entry.source,8)}-of-8.json`),w=JSON.parse(await readFile(file));w.translations[entry.source]=entry.translation;await save(file,w);}
 await save(join(project,'proof.json'),{fixture:true});const journalHash=sha256(await readFile(join(project,'proof.json')));
 await save(join(project,'generated/production/chapter-continuation-80pct.json'),{state:'fixture'});
 for(const base of [join(project,PARENT_RUN),join(run,'parent-snapshot/run')])await save(join(base,'original.json'),{unchanged:true});
 const tree=await treeHashes(join(project,PARENT_RUN));
 const manifest={id:FULL_ID,plan,retained:retained.map(r=>({...r,journalFile:'proof.json',journalHash})),program,inputs:{},
  parentTree:tree,parentSnapshotTree:tree,parentAudit:{parentLedgerHash:sha256(await readFile(join(project,'generated/production/chapter-continuation-80pct.json')))},
  config:{...PILOT_CONFIG,maxAttempts:plan.counts.maxAttempts},chapterPromptHash:CHAPTER_PROMPT_TEMPLATE_HASH,labelPromptHash:TRANSLATION_PROMPT_TEMPLATE_HASH,
  sourceHash:catalog.sourceHash,catalogHash:sha256(JSON.stringify(catalog)),terminologyHash:TERMINOLOGY_HASH,automaticPaidRetries:0};
 await save(join(run,'manifest.json'),manifest);const {ledger}=pureFixture();ledger.manifestHash=sha256(await readFile(join(run,'manifest.json')));await save(join(project,FULL_LEDGER),ledger);
 return project;
}
function fakeResponse(options={}){return async(_url,init)=>{
 const body=JSON.parse(init.body);assert.equal(body.model,'deepseek-v4-pro');assert.equal(body.max_tokens,32768);assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'max');assert.equal(body.stream,false);
 const {texts}=JSON.parse(body.messages[1].content);return new Response(JSON.stringify({model:'deepseek-v4-pro',
  usage:options.unknown?undefined:{prompt_tokens:10,completion_tokens:20,total_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(s=>s.replace('Whole paragraph','完整段落'))})}}]}));};}

const request38='c5e5aaea-92a9-41cf-9892-18bbfdf3646f';
const json=async p=>JSON.parse(await readFile(p));
const save=async(p,j)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(j));};
async function stopped38(t){
 const project=await stagedFixture(t);let calls=0;
 await assert.rejects(()=>executeFullSite({rootDir:project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{
  if(++calls===38)throw new Error('Synthetic network failure');return fakeResponse()(...args);
 }}),{code:'API_CONNECTION_FAILED'});
 const run=join(project,FULL_RUN),ws=join(run,'workspace'),ledger=await json(join(project,FULL_LEDGER)),manifest=await json(join(run,'manifest.json'));
 const a=ledger.attempts[37],oldFile=join(ws,a.journalFile),record=await json(oldFile);
 // Fixture-only fixed ID substitution: all data and journals are self-authored mocks.
 record.requestId=request38;a.requestId=request38;a.journalFile=`generated/translation-requests/full-38-body/${request38}.json`;
 await rm(oldFile);await save(join(ws,a.journalFile),record);await save(join(project,FULL_LEDGER),ledger);
 const bytes=await readFile(join(ws,a.journalFile)),job=manifest.plan.jobs[37];
 const permit={schemaVersion:1,approval:'approved-human-decision',humanOriginalQuote:'SYNTHETIC TEST PERMISSION ONLY',originalOrdinal:38,originalRequestId:request38,
  originalUnitId:job.unitId,originalSourceHash:sha256(job.texts[0]),originalRequestSourceHash:job.sourceHash,originalJournalFile:a.journalFile,originalJournalHash:sha256(bytes),
  oldAttemptLimit:171,newAttemptLimit:172,newHistoryLimit:613,replacementCount:1,possibleDuplicateCharge:true,approvalFile:'data/test-only-permission.json'};
 await save(join(ws,permit.approvalFile),permit);permit.approvalHash=sha256(await readFile(join(ws,permit.approvalFile)));
 return {project,run,ws,ledger,manifest,permit,record,bytes,calls};
}
async function mockAmend(f){
 f.manifest.authorizedUnknownReplacement=f.permit;f.manifest.inputs[f.permit.approvalFile]=f.permit.approvalHash;
 f.manifest.plan=applyFullSiteReplacement(f.manifest.plan,f.permit);f.manifest.config.maxAttempts=172;f.manifest.historyAttemptLimit=613;
 await save(join(f.run,'manifest.json'),f.manifest);f.ledger.manifestHash=sha256(await readFile(join(f.run,'manifest.json')));f.ledger.maxAttempts=172;f.ledger.historyAttemptLimit=613;
 await save(join(f.project,FULL_LEDGER),f.ledger);await save(join(f.run,'quota-ledger.json'),f.ledger);
}
test('pending proposal and unamended unknown cannot authorize a mock or paid resend',async t=>{
 const f=await stopped38(t);assert.equal(f.calls,38);assert.equal(plan.counts.prefill,164);assert.equal(plan.counts.maxAttempts,171);
 assert.throws(()=>applyFullSiteReplacement(plan,{...f.permit,approval:'pending-human-decision'}),{code:'RESUBMISSION_NOT_AUTHORIZED'});
 await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',fetchImpl:()=>assert.fail('unamended unknown attempted HTTP'),manageSignals:false,log:()=>{}}),{code:'UNKNOWN_ATTEMPT'});
});
test('only one exact request/source/cap-bound replacement can be planned',async t=>{
 const f=await stopped38(t);for(const patch of [{originalRequestId:'another-request'},{originalOrdinal:39},{originalSourceHash:'changed'},
  {replacementCount:2},{newAttemptLimit:173},{newHistoryLimit:614},{possibleDuplicateCharge:false},{approvalFile:'../outside.json'}])
 assert.throws(()=>applyFullSiteReplacement(plan,{...f.permit,...patch}),{code:'RESUBMISSION_NOT_AUTHORIZED'});
 const p=applyFullSiteReplacement(plan,f.permit);assert.equal(p.jobs.length,172);assert.equal(p.jobs[38].supersedesRequestId,request38);
 assert.deepEqual(p.jobs[38].texts,p.jobs[37].texts);assert.deepEqual(p.jobs[38].contexts,p.jobs[37].contexts);
 assert.equal(p.counts.remainingBody,112);assert.equal(p.counts.bodyRequests,113);assert.equal(p.counts.labelRequests,59);
 assert.throws(()=>applyFullSiteReplacement(p,f.permit),{code:'RESUBMISSION_NOT_AUTHORIZED'});
});
test('approved unknown remains hash-identical and null usage, never fabricated zero or completed',async t=>{
 const f=await stopped38(t);await mockAmend(f);
 verifyReviewedFullUnknown(f.record,f.manifest,f.ledger.attempts[37],sha256(f.bytes));
 for(const patch of [{rawUsage:{prompt_tokens:0,completion_tokens:0}},{returnedModel:'deepseek-v4-pro'}, {httpStatus:200},{type:'completed'}, {responseText:'invented'}])
 assert.throws(()=>verifyReviewedFullUnknown({...f.record,...patch},f.manifest,f.ledger.attempts[37],sha256(f.bytes)),{code:'REVIEWED_UNKNOWN_CHANGED'});
 assert.throws(()=>verifyReviewedFullUnknown(f.record,f.manifest,f.ledger.attempts[37],'0'.repeat(64)),{code:'REVIEWED_UNKNOWN_CHANGED'});
 const result=await recoverFullSite({rootDir:f.project});assert.equal(result.bodyCompleted,487);assert.equal(result.labelsCompleted,164);assert.equal(result.reviewedUnknown,1);assert.equal(result.unresolved,0);
 assert.equal((await json(join(f.project,FULL_LEDGER))).attempts[37].state,'unknown');assert.ok((await readFile(join(f.ws,f.ledger.attempts[37].journalFile))).equals(f.bytes));
});
test('amended mock run stops exactly at 172 / 1900, leaves unknown outside coverage and spends nothing on restart',async t=>{
 const f=await stopped38(t);await mockAmend(f);await recoverFullSite({rootDir:f.project});let calls=0;
 const result=await executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{calls++;return fakeResponse()(...args);}});
 assert.equal(calls,134);assert.equal(result.newAttempts,172);assert.equal(result.historyAttempts,613);assert.equal(result.state,'target-reached');
 assert.equal(result.bodyCompleted,562);assert.equal(result.labelsCompleted,1338);assert.equal(result.reviewedUnknown,1);assert.equal(result.unresolved,0);
 const l=await json(join(f.project,FULL_LEDGER));assert.equal(l.attempts[37].state,'unknown');assert.equal(l.attempts[38].supersedesRequestId,request38);assert.notEqual(l.attempts[38].requestId,request38);
 assert.equal((await json(join(f.ws,l.attempts[38].journalFile))).identity.supersedesRequestId,request38);
 assert.ok((await readFile(join(f.ws,f.ledger.attempts[37].journalFile))).equals(f.bytes));
 await executeFullSite({rootDir:f.project,fetchImpl:()=>assert.fail('completed restart attempted HTTP'),manageSignals:false,log:()=>{}});
 assert.equal(calls,134);assert.equal(nextFullJob(l,f.manifest,new Map(source.map(s=>[s,'mock-valid']))),null);
});
test('replacement crash after durable output recovers for free and does not resend it',async t=>{
 const f=await stopped38(t);await mockAmend(f);await recoverFullSite({rootDir:f.project});let calls=0;
 await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{calls++;return fakeResponse()(...args);},afterJournal:async()=>{throw new Error('Synthetic durable-output crash');}}));
 const r=await recoverFullSite({rootDir:f.project});assert.equal(r.bodyCompleted,488);assert.equal(r.newAttempts,39);
 await executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,shouldStop:()=>true,fetchImpl:()=>assert.fail('free recovery attempted HTTP'),log:()=>{}});assert.equal(calls,1);
});
test('a new unknown on the replacement immediately stops and cannot receive another replacement',async t=>{
 const f=await stopped38(t);await mockAmend(f);await recoverFullSite({rootDir:f.project});let calls=0;
 const options={rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async()=>{calls++;throw new Error('Synthetic second unknown');}};
 await assert.rejects(()=>executeFullSite(options),{code:'API_CONNECTION_FAILED'});const r=await readFullSiteStatus({rootDir:f.project});
 assert.equal(r.state,'review-required');assert.equal(r.newAttempts,39);assert.equal(r.bodyCompleted,487);assert.equal(r.reviewedUnknown,1);assert.equal(r.unknown,2);assert.equal(r.unresolved,1);
 await assert.rejects(()=>executeFullSite(options),{code:'UNKNOWN_ATTEMPT'});await assert.rejects(()=>recoverFullSite({rootDir:f.project}),{code:'UNKNOWN_ATTEMPT'});assert.equal(calls,1);
});
test('wrong approval bytes or mutated original journal are rejected before any fetch',async t=>{
 for(const which of ['approval','original']){
  const f=await stopped38(t);await mockAmend(f);
  if(which==='approval')await save(join(f.ws,f.permit.approvalFile),{invented:true});else await save(join(f.ws,f.ledger.attempts[37].journalFile),{...f.record,rawUsage:{prompt_tokens:0,completion_tokens:0}});
  await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:()=>assert.fail('tampering attempted HTTP')}));
 }
});

test('reviewed linked-title recovery preserves its failed journal and restart never repays that source',async t=>{
 const project=await stagedFixture(t),run=join(project,FULL_RUN),ws=join(run,'workspace');
 const c=await json(join(ws,'.cache/source/units.json')),m=await json(join(run,'manifest.json')),ledger=await json(join(project,FULL_LEDGER));
 const previous=c.units[525],linked=encodeChapter({id:'page:4a5250d6b05c3ba8',kind:'page',title:'acknowledgements-literature-list',
  html:'<span><a href="https://example.invalid/synthetic" target="_blank">SYNTHETIC, <b>Invented Break Patterns</b>, 2001.</a></span>',targets:[]});
 c.units[525]=linked;c.source=c.source.map(s=>s===previous.source?linked.source:s);c.sourceHash=sha256(JSON.stringify(c.source));c.catalogHash=hashUnitCatalog(c);
 await save(join(ws,'.cache/source/units.json'),c);await save(join(ws,'.cache/source/strings.json'),c.source);
 m.sourceHash=c.sourceHash;m.catalogHash=sha256(JSON.stringify(c));m.plan=createFullSitePlan(c,new Set(m.retained.map(r=>r.source)));
 for(let index=1;index<=8;index++){const file=join(ws,`generated/shards/zh-Hans-${index}-of-8.json`),s=await json(file);s.sourceHash=c.sourceHash;await save(file,s);}
 await save(join(run,'manifest.json'),m);ledger.manifestHash=sha256(await readFile(join(run,'manifest.json')));await save(join(project,FULL_LEDGER),ledger);
 let calls=0;const fetchImpl=async(...args)=>{
  if(++calls!==76)return fakeResponse()(...args);
  const {texts}=JSON.parse(JSON.parse(args[1].body).messages[1].content);assert.equal(texts[0],linked.source);
  const raw=texts[0].replace('Invented Break Patterns','自编节拍类型').replace('⟦m2⟧','').replace('⟦/m2⟧','');
  return Response.json({model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[raw]})}}]});
 };
 await assert.rejects(()=>executeFullSite({rootDir:project,apiKey:'mock-only',manageSignals:false,fetchImpl,log:()=>{}}),{code:'INVALID_CHAPTER_STRUCTURE'});
 const stopped=await json(join(project,FULL_LEDGER)),a=stopped.attempts[75],oldFile=join(ws,a.journalFile),record=await json(oldFile);
 // Fixed scoped identifiers belong to self-authored mock journals in this temp fixture.
 record.requestId='15f728d4-3ea4-4be0-b448-97bfe88843cd';a.requestId=record.requestId;a.journalFile=`generated/translation-requests/full-76-body/${record.requestId}.json`;
 await rm(oldFile);await save(join(ws,a.journalFile),record);await save(join(project,FULL_LEDGER),stopped);
 const bytes=await readFile(join(ws,a.journalFile)),raw=JSON.parse(record.responseText).translations[0],text='自编节拍类型',offset=raw.indexOf(text);
 const candidate=raw.slice(0,offset)+'⟦m2⟧'+text+'⟦/m2⟧'+raw.slice(offset+text.length);
 const proof={type:'reviewed-linked-title-bold-correction',requestId:record.requestId,unitId:linked.id,sourceHash:sha256(linked.source),originalJournalHash:sha256(bytes),originalResponseHash:sha256(record.responseText),
  markerId:'m2',parentMarkerId:'m1',sourceText:'Invented Break Patterns',translatedText:text,originalParentAttributes:linked.markers.m1.attributes,insertedAtUtf16:offset,expectedCandidateHash:sha256(candidate)};
 const proofFile=join(project,'owned-review-proof.json');await save(proofFile,proof);
 await registerFullSiteReview({rootDir:project,proofFile});const recovered=await recoverFullSite({rootDir:project});
 assert.equal(recovered.bodyCompleted,526);assert.equal(recovered.recovered,1);assert.equal(calls,76);
 assert.ok((await readFile(join(ws,a.journalFile))).equals(bytes));assert.equal((await json(join(ws,a.journalFile))).type,'failed');
 let stop=false;await executeFullSite({rootDir:project,apiKey:'mock-only',fetchImpl,manageSignals:false,shouldStop:()=>stop,afterJournal:async()=>{stop=true;},log:()=>{}});
 assert.equal(calls,77);assert.equal((await readFullSiteStatus({rootDir:project})).bodyCompleted,527);
 assert.ok((await readFile(join(ws,a.journalFile))).equals(bytes));
});


async function ownedLabelOmissionFixture(t){
 const f=await stopped38(t);await mockAmend(f);await recoverFullSite({rootDir:f.project});let calls=0;
 await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{
  if(++calls!==82)return fakeResponse()(...args);
  const {texts}=JSON.parse(JSON.parse(args[1].body).messages[1].content);assert.equal(texts.length,20);
  return Response.json({model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.filter((_,i)=>i!==18).map(s=>'自编：'+s)})}}]});
 }}),{code:'INVALID_TRANSLATION'});
 const ledger=await json(join(f.project,FULL_LEDGER)),manifest=await json(join(f.run,'manifest.json')),a=ledger.attempts[119],oldFile=join(f.ws,a.journalFile),record=await json(oldFile);
 assert.equal(ledger.attempts.length,120);record.requestId='cb6b9b93-25e7-4d68-a780-261cbaf8125b';a.requestId=record.requestId;a.journalFile=`generated/translation-requests/full-120-labels/${record.requestId}.json`;
 await rm(oldFile);await save(join(f.ws,a.journalFile),record);await save(join(f.project,FULL_LEDGER),ledger);
 const bytes=await readFile(join(f.ws,a.journalFile)),job=manifest.plan.jobs[119],tail=manifest.plan.jobs.at(-1),items=JSON.parse(record.responseText).translations;
 const review={type:'reviewed-label-omission-deferral',approval:'approved-coordinator-technical-amendment',originalUserCompletionQuote:'SYNTHETIC FIXTURE ONLY',requestId:record.requestId,ordinal:120,originalJobId:job.jobId,
  originalJournalHash:sha256(bytes),originalResponseHash:sha256(record.responseText),originalRequestSourceHash:job.sourceHash,sourceIndexForEachOutput:[...Array.from({length:18},(_,i)=>i),19],verbatimOutputHashes:items.map(sha256),
  missingSourceIndex:18,missingSourceHash:job.sourceHashes[18],tailOriginalJobId:tail.jobId,tailOriginalSourceHash:tail.sourceHash,cap:172,historyCap:613,additionalRequestReservations:0,reviewFile:`data/reviewed-label-deferrals/${record.requestId}.json`};
 const reviewFile=join(f.project,'owned-label-review.json');await save(reviewFile,review);return {...f,ledger,manifest,a,record,bytes,review,reviewFile,tail,calls};
}
test('reviewed19/20 labels are partial, missing source stays absent, final15 completes1900 within172 and restart spends zero',async t=>{
 const f=await ownedLabelOmissionFixture(t),missing=f.manifest.plan.jobs[119].texts[18];
 await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:f.reviewFile});const r=await recoverFullSite({rootDir:f.project});
 assert.equal(r.bodyCompleted,562);assert.equal(r.labelsCompleted,303);assert.equal(r.newAttempts,120);assert.equal(r.maxAttempts,172);assert.equal(r.unresolved,0);
 const partial=await json(join(f.project,FULL_LEDGER));assert.equal(partial.attempts[119].state,'recovered-partial');assert.equal(partial.attempts[119].recoveredSourceIndices.length,19);
 const all=new Map();for(let index=1;index<=8;index++)for(const [s,tr]of Object.entries((await json(join(f.ws,`generated/shards/zh-Hans-${index}-of-8.json`))).translations))all.set(s,tr);
 assert.ok(!all.has(missing));assert.ok((await readFile(join(f.ws,f.a.journalFile))).equals(f.bytes));
 let calls=0,lastTexts;
 const result=await executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{calls++;lastTexts=JSON.parse(JSON.parse(args[1].body).messages[1].content).texts;return fakeResponse()(...args);}});
 assert.equal(calls,52);assert.equal(result.newAttempts,172);assert.equal(result.historyAttempts,613);assert.equal(result.state,'target-reached');assert.equal(result.labelsCompleted,1338);assert.equal(result.bodyCompleted,562);
 assert.deepEqual(lastTexts,[...f.tail.texts,missing]);const final=await json(join(f.project,FULL_LEDGER));assert.equal(final.attempts[119].state,'recovered-partial');assert.equal(final.attempts[171].deferredFromRequestId,f.record.requestId);
 assert.ok((await readFile(join(f.ws,f.a.journalFile))).equals(f.bytes));assert.equal((await json(join(f.ws,f.a.journalFile))).type,'failed');
 await executeFullSite({rootDir:f.project,manageSignals:false,fetchImpl:()=>assert.fail('complete restart called API'),log:()=>{}});assert.equal(calls,52);
});
test('new unknown after reviewed partial labels still stops without another paid call',async t=>{
 const f=await ownedLabelOmissionFixture(t);await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:f.reviewFile});await recoverFullSite({rootDir:f.project});let calls=0;
 const opts={rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async()=>{calls++;throw new Error('Owned new unknown');}};
 await assert.rejects(()=>executeFullSite(opts),{code:'API_CONNECTION_FAILED'});await assert.rejects(()=>executeFullSite(opts),{code:'UNKNOWN_ATTEMPT'});assert.equal(calls,1);
 const r=await readFullSiteStatus({rootDir:f.project});assert.equal(r.labelsCompleted,303);assert.equal(r.newAttempts,121);assert.equal(r.state,'review-required');
});
test('partial label review rejects shifted mappings or altered raw output without changing original plan or budget',async t=>{
 const f=await ownedLabelOmissionFixture(t),before=await readFile(join(f.run,'manifest.json'));
 for(const patch of [{sourceIndexForEachOutput:Array.from({length:19},(_,i)=>i)},{originalResponseHash:'0'.repeat(64)},{cap:173}]){
  await save(f.reviewFile,{...f.review,...patch});await assert.rejects(()=>registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:f.reviewFile}));
  assert.ok((await readFile(join(f.run,'manifest.json'))).equals(before));
 }
 assert.equal((await json(join(f.project,FULL_LEDGER))).maxAttempts,172);assert.ok((await readFile(join(f.ws,f.a.journalFile))).equals(f.bytes));
});

async function ownedSecondOmissionFixture(t){
 const f=await ownedLabelOmissionFixture(t);await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:f.reviewFile});await recoverFullSite({rootDir:f.project});let calls=0;
 await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{
  if(++calls!==13)return fakeResponse()(...args);const {texts}=JSON.parse(JSON.parse(args[1].body).messages[1].content);
  return Response.json({model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.filter((_,i)=>![14,15,16,17].includes(i)).map(s=>'第二组自编：'+s)})}}]});
 }}),{code:'INVALID_TRANSLATION'});
 const ledger=await json(join(f.project,FULL_LEDGER)),manifest=await json(join(f.run,'manifest.json')),a=ledger.attempts[132],oldFile=join(f.ws,a.journalFile),record=await json(oldFile);
 assert.equal(ledger.attempts.length,133);record.requestId='55b33de9-fdfc-4cf0-8424-66fb6a8850e4';a.requestId=record.requestId;a.journalFile=`generated/translation-requests/full-133-labels/${record.requestId}.json`;
 await rm(oldFile);await save(join(f.ws,a.journalFile),record);await save(join(f.project,FULL_LEDGER),ledger);
 const bytes=await readFile(join(f.ws,a.journalFile)),job=manifest.plan.jobs[132],tail=manifest.plan.jobs.at(-1),items=JSON.parse(record.responseText).translations;
 const review={type:'reviewed-label-omission-deferral',approval:'approved-coordinator-technical-amendment',originalUserCompletionQuote:'SYNTHETIC FIXTURE ONLY',requestId:record.requestId,ordinal:133,originalJobId:job.jobId,
  originalJournalHash:sha256(bytes),originalResponseHash:sha256(record.responseText),originalRequestSourceHash:job.sourceHash,sourceIndexForEachOutput:[...Array.from({length:14},(_,i)=>i),18,19],verbatimOutputHashes:items.map(sha256),
  missingSourceIndices:[14,15,16,17],missingSourceHashes:[14,15,16,17].map(i=>job.sourceHashes[i]),tailOriginalJobId:tail.jobId,tailOriginalSourceHash:tail.sourceHash,cap:172,historyCap:613,additionalRequestReservations:0,reviewFile:`data/reviewed-label-deferrals/${record.requestId}.json`};
 const reviewFile=join(f.project,'owned-second-label-review.json');await save(reviewFile,review);return {...f,second:{ledger,manifest,a,record,bytes,review,reviewFile,tail,calls}};
}
test('two separately reviewed partial label outputs preserve both failures, final19 reaches1900 in172 and restart spends zero',async t=>{
 const f=await ownedSecondOmissionFixture(t),s=f.second;
 await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile});const recovered=await recoverFullSite({rootDir:f.project});
 assert.equal(recovered.labelsCompleted,559);assert.equal(recovered.newAttempts,133);assert.equal(recovered.recovered,2);assert.equal(recovered.maxAttempts,172);
 let calls=0,lastTexts;const complete=await executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{calls++;lastTexts=JSON.parse(JSON.parse(args[1].body).messages[1].content).texts;return fakeResponse()(...args);}});
 assert.equal(calls,39);assert.equal(complete.newAttempts,172);assert.equal(complete.state,'target-reached');assert.equal(complete.bodyCompleted,562);assert.equal(complete.labelsCompleted,1338);assert.equal(complete.historyAttempts,613);
 const job=s.manifest.plan.jobs[132];assert.deepEqual(lastTexts,[...s.tail.texts,...[14,15,16,17].map(i=>job.texts[i])]);assert.equal(lastTexts.length,19);
 const l=await json(join(f.project,FULL_LEDGER));assert.equal(l.attempts[119].state,'recovered-partial');assert.equal(l.attempts[132].state,'recovered-partial');assert.equal(l.attempts[171].reviewedDeferredSources.length,2);
 assert.ok((await readFile(join(f.ws,f.a.journalFile))).equals(f.bytes));assert.ok((await readFile(join(f.ws,s.a.journalFile))).equals(s.bytes));
 await executeFullSite({rootDir:f.project,manageSignals:false,fetchImpl:()=>assert.fail('completed second-deferral restart called API'),log:()=>{}});assert.equal(calls,39);
});
test('new unknown after second reviewed partial still blocks all new spending',async t=>{
 const f=await ownedSecondOmissionFixture(t),s=f.second;await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile});await recoverFullSite({rootDir:f.project});let calls=0;
 const opts={rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async()=>{calls++;throw new Error('Owned unknown after second partial');}};
 await assert.rejects(()=>executeFullSite(opts),{code:'API_CONNECTION_FAILED'});await assert.rejects(()=>executeFullSite(opts),{code:'UNKNOWN_ATTEMPT'});assert.equal(calls,1);
 const r=await readFullSiteStatus({rootDir:f.project});assert.equal(r.labelsCompleted,559);assert.equal(r.newAttempts,134);assert.equal(r.maxAttempts,172);assert.equal(r.state,'review-required');
});

async function ownedThirdOmissionFixture(t){
 const f=await ownedSecondOmissionFixture(t),s=f.second;await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile});await recoverFullSite({rootDir:f.project});let calls=0;
 await assert.rejects(()=>executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{
  if(++calls!==15)return fakeResponse()(...args);const {texts}=JSON.parse(JSON.parse(args[1].body).messages[1].content);
  return Response.json({model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.filter((_,i)=>i!==14).map(s=>'第三组自编：'+s)})}}]});
 }}),{code:'INVALID_TRANSLATION'});
 const ledger=await json(join(f.project,FULL_LEDGER)),manifest=await json(join(f.run,'manifest.json')),a=ledger.attempts[147],oldFile=join(f.ws,a.journalFile),record=await json(oldFile);
 assert.equal(ledger.attempts.length,148);record.requestId='841feac0-2380-4735-a0c8-edab6e4c2346';a.requestId=record.requestId;a.journalFile=`generated/translation-requests/full-148-labels/${record.requestId}.json`;
 await rm(oldFile);await save(join(f.ws,a.journalFile),record);await save(join(f.project,FULL_LEDGER),ledger);
 const bytes=await readFile(join(f.ws,a.journalFile)),job=manifest.plan.jobs[147],tail=manifest.plan.jobs.at(-1),items=JSON.parse(record.responseText).translations;
 const review={type:'reviewed-label-omission-deferral',approval:'approved-coordinator-technical-amendment',originalUserCompletionQuote:'SYNTHETIC FIXTURE ONLY',requestId:record.requestId,ordinal:148,originalJobId:job.jobId,
  originalJournalHash:sha256(bytes),originalResponseHash:sha256(record.responseText),originalRequestSourceHash:job.sourceHash,sourceIndexForEachOutput:[...Array.from({length:14},(_,i)=>i),15,16,17,18,19],verbatimOutputHashes:items.map(sha256),
  missingSourceIndices:[14],missingSourceHashes:[job.sourceHashes[14]],tailOriginalJobId:tail.jobId,tailOriginalSourceHash:tail.sourceHash,cap:172,historyCap:613,additionalRequestReservations:0,reviewFile:`data/reviewed-label-deferrals/${record.requestId}.json`};
 const reviewFile=join(f.project,'owned-third-label-review.json');await save(reviewFile,review);return {...f,third:{ledger,manifest,a,record,bytes,review,reviewFile,tail,calls}};
}
test('three separately reviewed partials preserve all failures, final20 reaches1900 in172 and complete restart spends zero',async t=>{
 const f=await ownedThirdOmissionFixture(t),s=f.third;await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile});const recovered=await recoverFullSite({rootDir:f.project});
 assert.equal(recovered.labelsCompleted,858);assert.equal(recovered.newAttempts,148);assert.equal(recovered.recovered,3);assert.equal(recovered.maxAttempts,172);
 const missing=s.manifest.plan.jobs[147].texts[14];const shards=new Map();for(let index=1;index<=8;index++)for(const pair of Object.entries((await json(join(f.ws,`generated/shards/zh-Hans-${index}-of-8.json`))).translations))shards.set(...pair);assert.ok(!shards.has(missing));
 let calls=0,lastTexts;const complete=await executeFullSite({rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(...args)=>{calls++;lastTexts=JSON.parse(JSON.parse(args[1].body).messages[1].content).texts;return fakeResponse()(...args);}});
 assert.equal(calls,24);assert.equal(complete.newAttempts,172);assert.equal(complete.state,'target-reached');assert.equal(complete.bodyCompleted,562);assert.equal(complete.labelsCompleted,1338);assert.equal(complete.historyAttempts,613);
 assert.deepEqual(lastTexts,[...s.tail.texts,missing]);assert.equal(lastTexts.length,20);
 const l=await json(join(f.project,FULL_LEDGER));assert.equal(l.attempts[119].state,'recovered-partial');assert.equal(l.attempts[132].state,'recovered-partial');assert.equal(l.attempts[147].state,'recovered-partial');assert.equal(l.attempts[171].reviewedDeferredSources.length,3);
 for(const original of [f,f.second,f.third])assert.ok((await readFile(join(f.ws,original.a.journalFile))).equals(original.bytes));
 await executeFullSite({rootDir:f.project,manageSignals:false,fetchImpl:()=>assert.fail('completed third-deferral restart called API'),log:()=>{}});assert.equal(calls,24);
});
test('new unknown after third reviewed partial blocks all new spending',async t=>{
 const f=await ownedThirdOmissionFixture(t),s=f.third;await registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile});await recoverFullSite({rootDir:f.project});let calls=0;
 const opts={rootDir:f.project,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async()=>{calls++;throw new Error('Owned unknown after third partial');}};
 await assert.rejects(()=>executeFullSite(opts),{code:'API_CONNECTION_FAILED'});await assert.rejects(()=>executeFullSite(opts),{code:'UNKNOWN_ATTEMPT'});assert.equal(calls,1);
 const r=await readFullSiteStatus({rootDir:f.project});assert.equal(r.labelsCompleted,858);assert.equal(r.newAttempts,149);assert.equal(r.maxAttempts,172);assert.equal(r.state,'review-required');
});
test('third profile rejects wrong mapping, extra cap or a changed original journal before installing',async t=>{
 const f=await ownedThirdOmissionFixture(t),s=f.third,before=await readFile(join(f.run,'manifest.json'));
 for(const patch of [{sourceIndexForEachOutput:Array.from({length:19},(_,i)=>i)},{originalJournalHash:'0'.repeat(64)},{cap:173},{additionalRequestReservations:1}]){
  await save(s.reviewFile,{...s.review,...patch});await assert.rejects(()=>registerFullSiteLabelDeferral({rootDir:f.project,reviewFile:s.reviewFile}));
  assert.ok((await readFile(join(f.run,'manifest.json'))).equals(before));assert.ok((await readFile(join(f.ws,s.a.journalFile))).equals(s.bytes));
 }
 assert.equal((await json(join(f.project,FULL_LEDGER))).maxAttempts,172);
});
