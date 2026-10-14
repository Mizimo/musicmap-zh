// Entirely self-authored data. No production snapshot, paid journal or key is read.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { cp,mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicJson } from '../../scripts/translate.mjs';
import { BASELINE,PILOT_RUN,PILOT_IDS,prepareChapterPilot,executeChapterPilot } from '../../lib/chapter-pilot.mjs';
import { prepareChapterContinuation,executeChapterContinuation,CONTINUATION_RUN as RUN50 } from '../../lib/chapter-continuation.mjs';
import { createUnitCatalog,hashUnitCatalog,isChapterSource,validateUnitCatalog } from '../../lib/chapter-units.mjs';
const project=fileURLToPath(new URL('../..',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex'),json=async p=>JSON.parse(await readFile(p));
const seeds=new Map();
after(async()=>{for(const promise of seeds.values())await rm(await promise,{recursive:true,force:true});});

function authoredSite(){
  const ids=Array.from({length:258},(_,i)=>`synthetic-${i}`);
  for(const [index,id]of [[0,'inl'],[1,'rnr'],[72,'alt07'],[205,'hct10'],[216,'hou03']])ids[index]=id;
  const genres=Object.fromEntries([...ids,...PILOT_IDS].map(id=>{
    let first=`This is a self-authored synthetic paragraph for ${id}.`;
    if(id==='alt07')first='An unmarked fictional Lo-Fi example precedes '+Array.from({length:11},(_,i)=>`<b>synthetic token ${i}</b> `).join('')+'<b>Lo-Fi</b> in this self-authored test.';
    if(id==='hct10')first='A fictional <b>decline</b> follows fictional <b>negative publicity</b> in this test.';
    return [id,{name:`Synthetic genre ${id}`,description:`${first}<br><br>A second complete synthetic paragraph for ${id}.<br><br>A third complete synthetic paragraph for ${id}.`}];
  }));
  const paragraphs=Array.from({length:292},(_,i)=>`<p id="synthetic-page-${i}">This is self-authored complete page paragraph ${i} for an offline test.</p>`).join('');
  const duplicates=ids.slice(0,10).map((id,i)=>`<p id="duplicate-page-${i}">${genres[id].description}</p>`).join('');
  const citations='<ul id="acknowledgements-literature-list"><li><span>SYNTHETIC, Ada, <b>Invented Chapter Guide</b>, Fixture Press, Test City, 2001.</span></li><li><span>SYNTHETIC, Bo, <b>Invented History Reader</b>, Fixture Press, Test City, 2002.</span></li></ul>';
  const bundle='window.onYouTubeIframeAPIReady=function(){P=new YT.Player("one",{});};function again(){P=new YT.Player("two",{});}function use(){'+'P.getPlayerState();'.repeat(10)+'P.playVideoAt(1);P.cuePlaylist({});P.cuePlaylist({});}';
  const base=`<html><head><title>Synthetic fixture</title></head><body>${paragraphs}${duplicates}${citations}`;
  const initial=createUnitCatalog({html:base+'</body></html>',genres,bundle});
  const buttons=Array.from({length:1338-initial.stats.labels},(_,i)=>`<button>Synthetic interface label ${i}</button>`).join('');
  return {html:base+buttons+'</body></html>',genres,bundle};
}
function arrangeSyntheticCatalog(catalog){
  const genre=catalog.units.filter(u=>u.kind==='genre'),genreSources=new Set(genre.map(u=>u.source));
  const pages=catalog.units.filter(u=>u.kind==='page'&&!genreSources.has(u.source));
  const duplicate=catalog.units.filter(u=>u.kind==='page'&&genreSources.has(u.source));
  const open=pages.find(u=>u.source.includes('Invented Chapter Guide')),nested=pages.find(u=>u.source.includes('Invented History Reader'));
  const ordered=pages.filter(u=>u!==open&&u!==nested);ordered.splice(91,0,open);ordered.splice(104,0,nested);
  ordered.forEach((u,i)=>{u.id=`page:synthetic-${i}`;});
  open.id='page:synthetic-open';nested.id='page:synthetic-nested';ordered[181].id='page:synthetic-stop';
  const labels=catalog.source.filter(s=>!isChapterSource(s));catalog.units=[...genre,...ordered,...duplicate];
  catalog.source=[...new Set([...catalog.units.map(u=>u.source),...labels])];catalog.sourceHash=hash(JSON.stringify(catalog.source));catalog.catalogHash=hashUnitCatalog(catalog);
  validateUnitCatalog(catalog);assert.equal(genre.length,268);assert.equal(catalog.units.length,572);assert.equal(new Set(catalog.units.map(u=>u.source)).size,562);assert.equal(catalog.source.length,1900);
  return catalog;
}
async function createPilotSeed(){
  const root=await mkdtemp(join(tmpdir(),'musicmap-authored-pilot-'));
  for(const folder of ['lib','scripts','public','data','benchmarks','test'])await cp(join(project,folder),join(root,folder),{recursive:true});
  for(const file of ['package.json','package-lock.json','server.mjs'])await cp(join(project,file),join(root,file));
  const site=authoredSite(),resource={
    'index.html':site.html,'master-genrelist.json':JSON.stringify(site.genres),'main.bundle.js':site.bundle,'main.css':'/* Self-authored test fixture. */',
  };
  const resources=Object.entries(resource).map(([path,text])=>({path,sha256:hash(text)}));
  const sourceHash=hash('self-authored legacy source fixture');
  for(const [path,text]of Object.entries(resource)){
    const file=join(root,'artifacts/synthetic-archive/files/generated/site',path);await mkdir(join(file,'..'),{recursive:true});
    const {writeFile}=await import('node:fs/promises');await writeFile(file,text);
  }
  await atomicJson(join(root,'artifacts/synthetic-archive/files/generated/source-manifest.json'),{sourceUrl:'https://example.invalid/synthetic',stringsSha256:sourceHash,resources});
  await atomicJson(join(root,'artifacts/synthetic-archive/manifest.json'),{marker:'v1-fragments-retired',files:Object.fromEntries(resources.map(r=>[`generated/site/${r.path}`,{sha256:r.sha256}]))});
  // Required historical identity fields are fictional fixture metadata, not
  // claims about a real source corpus or billable account.
  await atomicJson(join(root,BASELINE,'manifest.json'),{gitCommit:'8e7eb67c5034d0e7a7b0d6f6044de23cb3b93a89',status:{translated:5809},config:{maxTokens:32768,reasoningEffort:'max'},files:{'.cache/source/strings.json':sourceHash,...Object.fromEntries(resources.map(r=>[`generated/site/${r.path}`,r.sha256]))}});
  await atomicJson(join(root,'generated/production/retired.json'),{baseline:BASELINE,archive:'artifacts/synthetic-archive'});
  await prepareChapterPilot({rootDir:root});
  const ws=join(root,PILOT_RUN,'workspace'),m=await json(join(root,PILOT_RUN,'manifest.json'));
  const catalog=arrangeSyntheticCatalog(await json(join(ws,'.cache/source/units.json')));
  await atomicJson(join(ws,'.cache/source/units.json'),catalog);await atomicJson(join(ws,'.cache/source/strings.json'),catalog.source);
  m.sourceHash=catalog.sourceHash;m.catalogHash=hash(JSON.stringify(catalog));
  for(const file of ['.cache/source/units.json','.cache/source/strings.json'])m.inputs[file]=hash(await readFile(join(ws,file)));
  await atomicJson(join(root,PILOT_RUN,'manifest.json'),m);
  const ledgerFile=join(root,'generated/production/chapter-pilot.json'),ledger=await json(ledgerFile);ledger.manifestHash=hash(await readFile(join(root,PILOT_RUN,'manifest.json')));await atomicJson(ledgerFile,ledger);
  for(let i=1;i<=8;i++)await atomicJson(join(ws,`generated/shards/zh-Hans-${i}-of-8.json`),{sourceHash:catalog.sourceHash,language:'zh-Hans',shard:{index:i,count:8},translations:{}});
  return root;
}
function response(init,{paragraphArray=false}={}){
  const b=JSON.parse(init.body),{texts}=JSON.parse(b.messages[1].content);assert.equal(b.model,'deepseek-v4-pro');assert.equal(b.max_tokens,32768);assert.equal(b.reasoning_effort,'max');assert.equal(b.stream,false);assert.deepEqual(b.thinking,{type:'enabled'});
  const translated=texts[0].replace('⟦p0⟧','⟦p0⟧自編測試：');
  return Response.json({model:b.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:paragraphArray?translated.match(/⟦p\d+⟧[\s\S]*?⟦\/p\d+⟧/g):[translated]})}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:80,completion_tokens_details:{reasoning_tokens:30}}});
}
async function seed(stage){
  if(stage==='pilot-prepared')return createPilotSeed();
  const previous=await sharedSeed(stage==='pilot-completed'?'pilot-prepared':'pilot-completed');
  const root=await mkdtemp(join(tmpdir(),`musicmap-authored-${stage}-`));await cp(previous,root,{recursive:true});
  if(stage==='pilot-completed'){
    await executeChapterPilot({rootDir:root,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(_u,o)=>response(o)});
    await atomicJson(join(root,PILOT_RUN,'quota-ledger.json'),await json(join(root,'generated/production/chapter-pilot.json')));
  }
  else{
    await prepareChapterContinuation({rootDir:root});let calls=0;
    await assert.rejects(()=>executeChapterContinuation({rootDir:root,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async(_u,o)=>{
      if(++calls===217)throw new Error('Synthetic unknown network failure');return response(o,{paragraphArray:calls<=21});
    }}),{code:'API_CONNECTION_FAILED'});
    const l=await json(join(root,'generated/production/chapter-continuation-50pct.json'));assert.equal(l.attempts.length,217);assert.equal(l.attempts.filter(a=>a.state==='completed').length,216);assert.equal(l.attempts.filter(a=>a.recoveryFile).length,21);
    await atomicJson(join(root,RUN50,'quota-ledger.json'),l);
    const a=l.attempts.at(-1),unknownBytes=await readFile(join(root,RUN50,'workspace',a.journalFile)),j=JSON.parse(unknownBytes);assert.equal(j.rawUsage,null);
    await atomicJson(join(root,'generated/production/chapter-continuation-80-authorization.json'),{visibleOriginalUserQuote:'可以繼續推進musicmap到80%',coordinatorExecutionBoundary:{target:450,maxNewAttempts:224,retained:226,historyAttemptLimit:441},authorizedResubmission:{allowedCount:1,newIdRequired:true,originalOutcome:'unknown',requestId:a.requestId,journalHash:hash(unknownBytes)},syntheticFixture:true});
  }
  return root;
}
function sharedSeed(stage){if(!seeds.has(stage))seeds.set(stage,seed(stage));return seeds.get(stage);}
export async function syntheticHistoryFixture(t,stage){
  const rootDir=await mkdtemp(join(tmpdir(),`musicmap-synthetic-${stage}-`));t.after(()=>rm(rootDir,{recursive:true,force:true}));
  await cp(await sharedSeed(stage),rootDir,{recursive:true});return rootDir;
}
