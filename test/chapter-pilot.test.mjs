import {syntheticHistoryFixture} from './helpers/synthetic-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicJson } from '../scripts/translate.mjs';
import { prepareChapterPilot, executeChapterPilot, readChapterPilotStatus, BASELINE, PILOT_RUN, PILOT_IDS } from '../lib/chapter-pilot.mjs';
import { createTranslator, CHAPTER_PROTOCOL } from '../lib/translator.mjs';
import { assertLegacyTranslationAllowed } from '../lib/translation-retirement.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t) {
  const rootDir=await syntheticHistoryFixture(t,'pilot-prepared');
  return {rootDir,workspace:join(rootDir,PILOT_RUN,'workspace'),controlFile:join(rootDir,'generated/production/chapter-pilot.json')};
}
function fakeResponse(options, invalid=false) {
  const body=JSON.parse(options.body), input=JSON.parse(body.messages[1].content);
  assert.equal(body.model,'deepseek-v4-pro'); assert.equal(body.reasoning_effort,'max'); assert.equal(body.max_tokens,32768);
  assert.deepEqual(body.thinking,{type:'enabled'}); assert.equal(body.stream,false); assert.equal(input.texts.length,1);
  assert.ok(input.texts[0].startsWith('⟦p0⟧'));
  return Response.json({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[invalid?'只有殘缺譯文':input.texts[0].replace('⟦p0⟧','⟦p0⟧測試譯文：')]})}}],
    usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:80,completion_tokens_details:{reasoning_tokens:30}}});
}

test('global ten-attempt cap includes schema failures; restart and reprepare cannot buy an eleventh',async t=>{
  const {rootDir,workspace}=await fixture(t); let calls=0;
  const fetchImpl=async (_url,options)=>fakeResponse(options,++calls===1);
  const result=await executeChapterPilot({rootDir,apiKey:'mock-only',fetchImpl,manageSignals:false,log:()=>{}});
  assert.equal(result.state,'awaiting-review'); assert.equal(result.attempts,10); assert.equal(result.completed,9); assert.equal(result.failed,1); assert.equal(calls,10);
  await prepareChapterPilot({rootDir});
  await executeChapterPilot({rootDir,apiKey:'mock-only',fetchImpl:()=>assert.fail('11th API call'),manageSignals:false,log:()=>{}});
  let count=0; for(const file of await readdir(join(workspace,'generated/shards'))) count+=Object.keys((await json(join(workspace,'generated/shards',file))).translations).length;
  assert.equal(count,9);
  await assert.rejects(()=>assertLegacyTranslationAllowed(rootDir),{code:'TRANSLATION_RETIRED'});
  await assert.rejects(()=>assertLegacyTranslationAllowed(workspace),{code:'TRANSLATION_RETIRED'});
});

test('two processes cannot share the pilot; stop finishes its only in-flight chapter',async t=>{
  const {rootDir}=await fixture(t); let enter,finish,calls=0;
  const entered=new Promise(r=>enter=r), pending=new Promise(r=>finish=r);
  const running=executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,shouldStop:()=>calls>=1,log:()=>{},
    fetchImpl:async(_url,options)=>{calls++;enter();await pending;return fakeResponse(options);}});
  await entered;
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false}),/Translation lock exists/);
  finish(); const stopped=await running;
  assert.equal(stopped.state,'paused');assert.equal(stopped.attempts,1);assert.equal(stopped.completed,1);assert.equal(calls,1);
});

test('completed journal restores an interrupted export with zero new calls',async t=>{
  const {rootDir,workspace,controlFile}=await fixture(t);
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{},
    fetchImpl:async(_url,options)=>fakeResponse(options),afterJournal:async()=>{throw new Error('simulated export crash');}}),/simulated export crash/);
  let control=await json(controlFile);assert.equal(control.attempts.length,1);
  const shardPath=join(workspace,`generated/shards/zh-Hans-${control.attempts[0].shard}-of-8.json`);
  assert.equal(Object.keys((await json(shardPath)).translations).length,0);
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:()=>assert.fail('must recover without spending')}),/review/);
  assert.equal(Object.keys((await json(shardPath)).translations).length,1);
  control=await json(controlFile);assert.equal(control.attempts.length,1);assert.equal(control.attempts[0].state,'completed');
});

test('unknown-billing failure is charged one slot and blocks all later calls',async t=>{
  const {rootDir}=await fixture(t);let calls=0;
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:async()=>{calls++;throw new Error('network ended');}}),{code:'API_CONNECTION_FAILED'});
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,log:()=>{},fetchImpl:()=>assert.fail('unknown billing retry')}),{code:'UNRESOLVED_ATTEMPT'});
  const status=await readChapterPilotStatus({rootDir});assert.equal(status.attempts,1);assert.equal(status.uncertain,1);assert.equal(calls,1);
});

test('frozen source/program changes block before reserving or sending; selection is immutable',async t=>{
  const {rootDir,workspace}=await fixture(t);
  const manifest=await json(join(rootDir,PILOT_RUN,'manifest.json'));
  assert.deepEqual(manifest.selected.map(x=>x.chapterId),PILOT_IDS);
  assert.equal(manifest.selected.reduce((n,x)=>n+x.paragraphs,0),30);
  const file=join(workspace,'.cache/source/strings.json');await writeFile(file,'["wrong source"]');
  await assert.rejects(()=>executeChapterPilot({rootDir,apiKey:'mock-only',manageSignals:false,fetchImpl:()=>assert.fail('changed source call')}),{code:'PILOT_FROZEN_INPUT_CHANGED'});
  assert.equal((await readChapterPilotStatus({rootDir})).attempts,0);
});

test('chapter validation happens before a completed journal/cache; fragment cache never substitutes',async t=>{
  const cacheDir=await mkdtemp(join(tmpdir(),'chapter-validator-'));t.after(()=>rm(cacheDir,{recursive:true,force:true}));
  const events=[];let calls=0;
  const translator=createTranslator({apiKey:'mock-only',unitProtocol:CHAPTER_PROTOCOL,cacheDir,onRequest:event=>events.push(event),
    fetchImpl:async(_url,options)=>{calls++;return fakeResponse(options,true);}});
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['⟦p0⟧A complete ⟦m0⟧chapter⟦/m0⟧.⟦/p0⟧']}),{code:'INVALID_CHAPTER_STRUCTURE'});
  assert.deepEqual(events.map(x=>x.type),['started','failed']);assert.equal(calls,1);
  assert.equal((await readdir(cacheDir)).length,0);assert.ok(events[1].responseText.includes('殘缺'));
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['A','chapter']}),{code:'INVALID_REQUEST'});
});

test('stop arriving during the started-journal write prevents the HTTP request',async t=>{
  const cacheDir=await mkdtemp(join(tmpdir(),'chapter-stop-boundary-'));t.after(()=>rm(cacheDir,{recursive:true,force:true}));
  let stop=false;const events=[];
  const translator=createTranslator({apiKey:'mock-only',unitProtocol:CHAPTER_PROTOCOL,cacheDir,shouldStop:()=>stop,
    onRequest:async event=>{events.push(event);if(event.type==='started')stop=true;},
    fetchImpl:()=>assert.fail('stop arrived before send')});
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['⟦p0⟧Whole chapter.⟦/p0⟧']}),{code:'STOP_REQUESTED_BEFORE_SEND'});
  assert.deepEqual(events.map(x=>x.type),['started','failed']);assert.equal(events[1].requestSent,false);
});

test('an uncertain completed journal callback never overwrites paid success as failure',async t=>{
  const cacheDir=await mkdtemp(join(tmpdir(),'chapter-journal-boundary-'));t.after(()=>rm(cacheDir,{recursive:true,force:true}));
  const events=[];
  const translator=createTranslator({apiKey:'mock-only',unitProtocol:CHAPTER_PROTOCOL,cacheDir,
    onRequest:async event=>{events.push(event);if(event.type==='completed')throw new Error('disk acknowledgement lost');},
    fetchImpl:async(_url,options)=>fakeResponse(options)});
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['⟦p0⟧Whole chapter.⟦/p0⟧']}),{code:'REQUEST_LOG_FAILED'});
  assert.deepEqual(events.map(x=>x.type),['started','completed']);
});

test('contradictory provider usage stops before completing or caching the chapter',async t=>{
  const cacheDir=await mkdtemp(join(tmpdir(),'chapter-usage-'));t.after(()=>rm(cacheDir,{recursive:true,force:true}));
  const events=[];const translator=createTranslator({apiKey:'mock-only',unitProtocol:CHAPTER_PROTOCOL,cacheDir,
    onRequest:event=>events.push(event),fetchImpl:async(_url,options)=>{
      const payload=await fakeResponse(options).json();payload.usage.total_tokens=999;return Response.json(payload);
    }});
  await assert.rejects(()=>translator.translate({language:'zh-Hans',texts:['⟦p0⟧Whole chapter.⟦/p0⟧']}),{code:'INCONSISTENT_USAGE'});
  assert.deepEqual(events.map(x=>x.type),['started','failed']);assert.equal(events[1].rawUsage.total_tokens,999);
  assert.equal((await readdir(cacheDir)).length,0);
});
