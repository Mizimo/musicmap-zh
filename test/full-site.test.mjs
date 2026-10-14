import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeChapter,hashUnitCatalog} from '../lib/chapter-units.mjs';
import {sha256,treeHashes,knownUsage,PARENT_RUN} from '../lib/full-site-parent.mjs';
import {FULL_PROGRAM,FULL_ID,FULL_RUN,FULL_LEDGER,createFullSitePlan,nextFullJob,validateFullLedger,
  executeFullSite,recoverFullSite,readFullSiteStatus,validateLabel} from '../lib/full-site.mjs';
import {PILOT_CONFIG} from '../lib/chapter-pilot.mjs';
import {CHAPTER_PROMPT_TEMPLATE_HASH,TRANSLATION_PROMPT_TEMPLATE_HASH,createTranslator} from '../lib/translator.mjs';
import {TERMINOLOGY_HASH} from '../lib/terminology.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const units=Array.from({length:562},(_,i)=>encodeChapter({id:`page:test${i}`,kind:'page',title:'Test',html:`Whole paragraph ${i}.`,targets:[]}));
const labels=['Accept','  SEARCH  ',...Array.from({length:1336},(_,i)=>`Independent label ${i}`)];
const source=[...units.map(u=>u.source),...labels],catalog={schemaVersion:1,protocol:'musicmap-chapters-v1',snapshotHash:'test',source,sourceHash:sha256(JSON.stringify(source)),units:[...units,...units.slice(0,10)],stats:{}};
catalog.catalogHash=hashUnitCatalog(catalog);
const retained=units.slice(0,450).map(u=>({source:u.source,unitId:u.id,translation:u.source,translationHash:sha256(u.source)}));
const plan=createFullSitePlan(catalog,new Set(retained.map(r=>r.source)));
function pureFixture(){return {manifest:{plan},ledger:{id:FULL_ID,run:FULL_RUN,maxAttempts:plan.counts.maxAttempts,target:1900,priorAttempts:441,state:'prepared',attempts:[]}};}
test('full catalog selection keeps complete body sources and bounded independent label batches',()=>{
 assert.equal(plan.counts.remainingBody,112);assert.equal(plan.counts.bodyRequests,112);assert.equal(plan.counts.prefill,2);assert.equal(plan.counts.pendingLabels,1336);
 assert.equal(plan.counts.labelRequests,67);assert.equal(plan.counts.maxAttempts,179);
 assert.equal(plan.jobs[0].unitId,units[450].id);assert.equal(plan.jobs[111].unitId,units[561].id);
 assert.ok(plan.jobs.filter(j=>j.kind==='labels').every(j=>j.texts.length<=20&&j.texts.reduce((n,s)=>n+s.length,0)<=14000));
 assert.equal(new Set(plan.jobs.flatMap(j=>j.texts)).size,1448);assert.equal(plan.prefill[1].provenance.type,'frozen-dictionary-normalized-match');
});
test('exact full stop and persistent cap cannot become extra paid attempts',()=>{
 const {manifest,ledger}=pureFixture();assert.equal(nextFullJob(ledger,manifest,new Map(source.map(s=>[s,'valid']))),null);
 ledger.attempts=plan.jobs.map((j,i)=>({ordinal:i+1,historyOrdinal:442+i,jobId:j.jobId,kind:j.kind,sourceHash:j.sourceHash,state:'completed',requestId:`id-${i}`}));
 assert.equal(nextFullJob(ledger,manifest,new Map(source.slice(0,1899).map(s=>[s,'valid']))),null);
 ledger.maxAttempts++;assert.throws(()=>validateFullLedger(ledger,manifest),{code:'LEDGER_INVALID'});
});
test('unknown reservations, duplicate spending and source mutation block new requests',()=>{
 const {manifest,ledger}=pureFixture();const j=plan.jobs[0];
 assert.throws(()=>nextFullJob(ledger,manifest,new Map([[j.texts[0],'existing']])),{code:'DUPLICATE_SPENDING'});
 ledger.attempts=[{ordinal:1,historyOrdinal:442,jobId:j.jobId,kind:j.kind,sourceHash:j.sourceHash,state:'unknown'}];
 assert.throws(()=>nextFullJob(ledger,manifest,new Map()),{code:'REVIEW_REQUIRED'});
 ledger.attempts[0].sourceHash='changed';assert.throws(()=>validateFullLedger(ledger,manifest),{code:'LEDGER_INVALID'});
});
test('label safety and token arithmetic reject invalid data',()=>{
 for(const s of ['', '<script>run()</script>','⟦p0⟧x⟦/p0⟧'])assert.throws(()=>validateLabel('Label',s),{code:'INVALID_LABEL'});
 validateLabel('Miles Davis','Miles Davis');assert.equal(knownUsage({rawUsage:{prompt_tokens:2,completion_tokens:3,total_tokens:6}}),false);
 assert.equal(knownUsage({rawUsage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,prompt_cache_hit_tokens:-1}}),false);
});
for(const broken of ['missing-model','missing-usage','bad-total'])test(`strict label request stops on ${broken}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mm-label-'));const events=[];
 try{const translator=createTranslator({apiKey:'sk-test',requireKnownUsage:true,cacheDir:dir,onRequest:e=>events.push(e),fetchImpl:async()=>new Response(JSON.stringify({
  model:broken==='missing-model'?undefined:'deepseek-v4-pro',usage:broken==='missing-usage'?undefined:{prompt_tokens:1,completion_tokens:1,total_tokens:broken==='bad-total'?3:2},
  choices:[{finish_reason:'stop',message:{content:'{"translations":["测试"]}'}}]}))});
 await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['Test']}));assert.equal(events.at(-1).type,'failed');assert.equal(events.at(-1).responseText,'{"translations":["测试"]}');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('strict label format rejection preserves original response, model and known usage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mm-label-format-'));const events=[];
 const responseText='{"translations":["测试","extra item"]}';
 const usage={prompt_tokens:12,completion_tokens:8,total_tokens:20,prompt_cache_hit_tokens:6,prompt_cache_miss_tokens:6,
  completion_tokens_details:{reasoning_tokens:4}};
 try{
  const translator=createTranslator({apiKey:'sk-test',requireKnownUsage:true,cacheDir:dir,onRequest:e=>events.push(e),fetchImpl:async()=>Response.json({
   model:'deepseek-v4-pro',usage,choices:[{finish_reason:'stop',message:{content:responseText}}]})});
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['Test']}),{code:'INVALID_TRANSLATION'});
  const event=events.at(-1);assert.equal(event.type,'failed');assert.equal(event.responseText,responseText);
  assert.equal(event.returnedModel,'deepseek-v4-pro');assert.equal(event.httpStatus,200);assert.equal(event.finishReason,'stop');
  assert.deepEqual(event.rawUsage,usage);assert.equal(event.sourceCount,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
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
test('restart recovers a durable completed journal without a second paid call',async t=>{
 const project=await stagedFixture(t);let calls=0,stop=false;const fetchImpl=async(...args)=>{calls++;return fakeResponse()(...args);};
 await executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,shouldStop:()=>stop,afterJournal:async()=>{stop=true;},log:()=>{}});
 assert.equal(calls,1);assert.equal((await readFullSiteStatus({rootDir:project})).bodyCompleted,451);
 stop=false;await assert.rejects(()=>executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,afterJournal:async()=>{throw new Error('Simulated crash after durable journal');},log:()=>{}}));
 assert.equal(calls,2);const recovered=await recoverFullSite({rootDir:project});assert.equal(recovered.bodyCompleted,452);assert.equal(recovered.newAttempts,2);
 stop=true;await executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,shouldStop:()=>stop,log:()=>{}});assert.equal(calls,2);
});
test('new unknown usage persists across restart and forbids another API call',async t=>{
 const project=await stagedFixture(t);let calls=0;const fetchImpl=async(...args)=>{calls++;return fakeResponse({unknown:true})(...args);};
 await assert.rejects(()=>executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,log:()=>{}}));
 const before=await readFullSiteStatus({rootDir:project});assert.equal(before.state,'review-required');assert.equal(before.newAttempts,1);
 await assert.rejects(()=>executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,log:()=>{}}));assert.equal(calls,1);
});
test('all body and label jobs stop at exactly 1900, and a completed restart spends nothing',async t=>{
 const project=await stagedFixture(t);let calls=0,active=0,peak=0;
 const fetchImpl=async(...args)=>{calls++;active++;peak=Math.max(peak,active);try{return await fakeResponse()(...args);}finally{active--;}};
 const result=await executeFullSite({rootDir:project,apiKey:'sk-test',fetchImpl,manageSignals:false,log:()=>{}});
 assert.equal(result.state,'target-reached');assert.equal(result.bodyCompleted,562);assert.equal(result.labelsCompleted,1338);
 assert.equal(result.newAttempts,plan.counts.maxAttempts);assert.equal(calls,179);assert.equal(peak,1);
 const ledgerBytes=await readFile(join(project,FULL_LEDGER));
 await executeFullSite({rootDir:project,fetchImpl:()=>assert.fail('completed restart called API'),manageSignals:false,log:()=>{}});
 assert.equal(calls,179);assert.deepEqual(JSON.parse(await readFile(join(project,FULL_LEDGER))).attempts,JSON.parse(ledgerBytes).attempts);
});
