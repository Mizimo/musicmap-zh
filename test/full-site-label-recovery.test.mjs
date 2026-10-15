import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../lib/full-site-parent.mjs';
import {validateLabel} from '../lib/full-site.mjs';
import {createTranslator} from '../lib/translator.mjs';
import {applyReviewedLabelDeferral,recoverReviewedPartialLabels} from '../lib/full-site-label-recovery.mjs';
const texts=Array.from({length:20},(_,i)=>`Self-authored label ${i}`),tailTexts=Array.from({length:14},(_,i)=>`Self-authored final ${i}`);
const job={jobId:'labels-119',kind:'labels',texts,contexts:texts.map(()=>''),sourceHashes:texts.map(sha256),sourceHash:sha256(JSON.stringify(texts))};
const tail={jobId:'labels-171',kind:'labels',texts:tailTexts,contexts:tailTexts.map(()=>''),sourceHashes:tailTexts.map(sha256),sourceHash:sha256(JSON.stringify(tailTexts))};
const plan={jobs:Array.from({length:172},(_,i)=>i===119?job:i===171?tail:{jobId:`owned-${i}`,texts:[`Owned${i}`]}),counts:{maxAttempts:172,pendingLabels:1174,labelRequests:59,bodyRequests:113}};
const indices=[...Array.from({length:18},(_,i)=>i),19],outputs=indices.map(i=>`自编标签 ${i}`),responseText=JSON.stringify({translations:outputs});
const record={type:'failed',requestId:'cb6b9b93-25e7-4d68-a780-261cbaf8125b',errorCode:'INVALID_TRANSLATION',sourceCount:20,sourceHash:job.sourceHash,responseText};
const review={type:'reviewed-label-omission-deferral',approval:'approved-coordinator-technical-amendment',requestId:record.requestId,ordinal:120,originalJobId:job.jobId,
 originalRequestSourceHash:job.sourceHash,originalJournalHash:sha256('Owned journal'),originalResponseHash:sha256(responseText),sourceIndexForEachOutput:indices,verbatimOutputHashes:outputs.map(sha256),
 missingSourceIndex:18,missingSourceHash:job.sourceHashes[18],tailOriginalJobId:tail.jobId,tailOriginalSourceHash:tail.sourceHash,cap:172,historyCap:613,additionalRequestReservations:0,
 reviewFile:`data/reviewed-label-deferrals/${record.requestId}.json`,reviewHash:sha256('Owned review')};
test('one reviewed omission changes only the unsent final14 to15 while keeping172 reservations',()=>{
 const result=applyReviewedLabelDeferral(plan,review);assert.equal(result.jobs.length,172);assert.equal(result.counts.maxAttempts,172);
 assert.deepEqual(result.jobs.slice(0,-1),plan.jobs.slice(0,-1));assert.deepEqual(result.jobs.at(-1).texts,[...tailTexts,texts[18]]);
 assert.equal(result.jobs.at(-1).deferredFromRequestId,record.requestId);assert.equal(result.jobs.at(-1).deferredSourceIndex,18);assert.equal(result.jobs[119].texts.length,20);
 assert.equal(result.counts.pendingLabels,1174);assert.equal(result.counts.paidLabelInputItems,1175);
});
test('partial recovery returns exactly the19 unchanged strings and excludes the missing source',()=>{
 const result=recoverReviewedPartialLabels(job,record,review,review.originalJournalHash,validateLabel);
 assert.deepEqual(result.translations,outputs);assert.deepEqual(result.sourceIndices,indices);assert.ok(!result.sourceIndices.includes(18));
 assert.equal(result.recoveredSourceCount,19);assert.equal(result.originalSourceCount,20);assert.equal(result.addedPaidRequests,0);assert.equal(result.translatedTextChanged,false);
});
test('pending decisions, other requests, altered mappings or budgets do not grant label deferrals',()=>{
 for(const patch of [{approval:'pending'},{requestId:'another-request'},{ordinal:121},{sourceIndexForEachOutput:Array.from({length:19},(_,i)=>i)},
  {originalRequestSourceHash:'0'.repeat(64)},{missingSourceHash:'0'.repeat(64)},{tailOriginalSourceHash:'0'.repeat(64)},
  {cap:173},{historyCap:614},{additionalRequestReservations:1}])assert.throws(()=>applyReviewedLabelDeferral(plan,{...review,...patch}),{code:'LABEL_DEFERRAL_INVALID'});
 assert.throws(()=>applyReviewedLabelDeferral(applyReviewedLabelDeferral(plan,review),review),{code:'LABEL_DEFERRAL_INVALID'});
});
test('partial output rejects wrong journal/response hashes, edits, missing items and HTML',()=>{
 assert.throws(()=>recoverReviewedPartialLabels(job,record,review,'0'.repeat(64),validateLabel),{code:'LABEL_DEFERRAL_INVALID'});
 assert.throws(()=>recoverReviewedPartialLabels(job,{...record,sourceCount:19},review,review.originalJournalHash,validateLabel),{code:'LABEL_DEFERRAL_INVALID'});
 for(const values of [outputs.slice(1),[...outputs,'Extra'],outputs.map((s,i)=>i===0?s+'edited':s)]){
  const r={...record,responseText:JSON.stringify({translations:values})};assert.throws(()=>recoverReviewedPartialLabels(job,r,review,review.originalJournalHash,validateLabel));
 }
 const html=outputs.map((s,i)=>i===0?'<script>bad()</script>':s),encoded=JSON.stringify({translations:html});
 assert.throws(()=>recoverReviewedPartialLabels(job,{...record,responseText:encoded},{...review,originalResponseHash:sha256(encoded),verbatimOutputHashes:html.map(sha256)},review.originalJournalHash,validateLabel),{code:'INVALID_LABEL'});
});
test('original transport still rejects19 translations for20 sources and retains original response and usage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'owned-label-count-')),events=[];
 try{const t=createTranslator({apiKey:'mock-only',requireKnownUsage:true,cacheDir:dir,onRequest:e=>events.push(e),fetchImpl:async()=>Response.json({model:'deepseek-v4-pro',usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50},choices:[{finish_reason:'stop',message:{content:responseText}}]})});
  await assert.rejects(()=>t.translate({language:'zh-Hans',texts}),{code:'INVALID_TRANSLATION'});assert.equal(events.at(-1).responseText,responseText);assert.equal(events.at(-1).rawUsage.total_tokens,50);assert.equal(events.at(-1).type,'failed');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('second reviewed profile keeps16 strings and appends only4 missing items into final19 without extra reservations',()=>{
 const first=applyReviewedLabelDeferral(plan,review),secondTexts=Array.from({length:20},(_,i)=>`Another owned label ${i}`),secondJob={...job,jobId:'labels-132',texts:secondTexts,sourceHashes:secondTexts.map(sha256),sourceHash:sha256(JSON.stringify(secondTexts))};
 const prepared={...first,jobs:first.jobs.map((j,i)=>i===132?secondJob:j)},map=[...Array.from({length:14},(_,i)=>i),18,19],values=map.map(i=>`第二组自编 ${i}`),response=JSON.stringify({translations:values});
 const second={...review,requestId:'55b33de9-fdfc-4cf0-8424-66fb6a8850e4',ordinal:133,originalJobId:secondJob.jobId,originalRequestSourceHash:secondJob.sourceHash,sourceIndexForEachOutput:map,verbatimOutputHashes:values.map(sha256),originalResponseHash:sha256(response),
  missingSourceIndices:[14,15,16,17],missingSourceHashes:[14,15,16,17].map(i=>secondJob.sourceHashes[i]),tailOriginalJobId:first.jobs.at(-1).jobId,tailOriginalSourceHash:first.jobs.at(-1).sourceHash};
 const result=applyReviewedLabelDeferral(prepared,second);assert.equal(result.jobs.length,172);assert.equal(result.jobs.at(-1).texts.length,19);assert.deepEqual(result.jobs.slice(0,-1),prepared.jobs.slice(0,-1));
 assert.deepEqual(result.jobs.at(-1).texts,[...first.jobs.at(-1).texts,...[14,15,16,17].map(i=>secondTexts[i])]);assert.equal(result.counts.reviewedDeferredLabels,5);assert.equal(result.counts.paidLabelInputItems,1179);
 const partial=recoverReviewedPartialLabels(secondJob,{...record,requestId:second.requestId,sourceHash:secondJob.sourceHash,responseText:response},second,second.originalJournalHash,validateLabel);assert.deepEqual(partial.translations,values);assert.equal(partial.recoveredSourceCount,16);assert.deepEqual(partial.missingSourceIndices,[14,15,16,17]);
 assert.throws(()=>applyReviewedLabelDeferral(plan,second),{code:'LABEL_DEFERRAL_INVALID'});assert.throws(()=>applyReviewedLabelDeferral(result,second),{code:'LABEL_DEFERRAL_INVALID'});
});
test('reviewed label profiles do not authorize other missing-count mappings or an unreviewed request',()=>{
 assert.throws(()=>applyReviewedLabelDeferral(plan,{...review,requestId:'a-third-request'}),{code:'LABEL_DEFERRAL_INVALID'});
 assert.throws(()=>applyReviewedLabelDeferral(plan,{...review,sourceIndexForEachOutput:[...Array.from({length:14},(_,i)=>i),18,19]}),{code:'LABEL_DEFERRAL_INVALID'});
});
