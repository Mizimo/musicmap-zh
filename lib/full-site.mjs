import assert from 'node:assert/strict';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dictionary } from '../public/dictionary.js';
import { TERMINOLOGY, TERMINOLOGY_HASH, SIMPLIFIED_TERMINOLOGY_HASH } from './terminology.mjs';
import { createTranslator, CHAPTER_PROMPT_TEMPLATE_HASH, TRANSLATION_PROMPT_TEMPLATE_HASH } from './translator.mjs';
import { validateUnitCatalog, validateChapterTranslation, isChapterSource } from './chapter-units.mjs';
import * as formatRecovery from './chapter-format-recovery-80.mjs';
import { recoverReviewedLinkedTitleBold } from './full-site-format-recovery.mjs';
import { applyReviewedLabelDeferral,applyReviewedLabelDeferrals,labelDeferralReviews,labelDeferralReviewFor,isReviewedPartialLabel,recoverReviewedPartialLabels } from './full-site-label-recovery.mjs';
import { PILOT_CONFIG } from './chapter-pilot.mjs';
import { acquireTranslationLock, createTranslationJournal, readTranslationKey } from './translation-journal.mjs';
import { atomicJson, PROJECT_ROOT, shardForText, validateShardWrapper } from '../scripts/translate.mjs';
import { auditFullSiteParent, PARENT_RUN, sha256, readJson, treeHashes, knownUsage } from './full-site-parent.mjs';

export const FULL_ID='whole-site-pro-max-complete-v1';
export const FULL_RUN='artifacts/full-site/2026-10-15-complete';
export const FULL_LEDGER='generated/production/full-site-complete.json';
export const FULL_AUTH='generated/production/full-site-authorization.json';
const now=()=>new Date().toISOString();
const normalize=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const optionalJson=async file=>{try{return await readJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const FULL_PROGRAM=['lib/full-site.mjs','lib/full-site-parent.mjs','lib/full-site-format-recovery.mjs','lib/full-site-label-recovery.mjs','scripts/complete-site.mjs',
  'lib/chapter-pilot.mjs','lib/chapter-units.mjs','lib/translator.mjs','lib/translation-journal.mjs',
  'lib/translation-retirement.mjs','lib/terminology.mjs','lib/benchmark-cost.mjs','lib/chinese-conversion.mjs',
  'lib/chapter-format-recovery.mjs','lib/chapter-format-recovery-80.mjs',
  'scripts/translate.mjs','scripts/merge-translations.mjs','scripts/convert.mjs','scripts/build.mjs','scripts/sync-source.mjs',
  'public/chapter-renderer.js','public/chapter-caption-renderer.js','public/overlay.js','public/overlay.css',
  'public/dictionary.js','data/terminology.json','benchmarks/pricing.json','package-lock.json','package.json','server.mjs'];
async function fileHashes(root,names){return Object.fromEntries(await Promise.all(names.map(async n=>[n,sha256(await readFile(join(root,n)))])));}
async function verifyHashes(root,expected){for(const[n,h]of Object.entries(expected))if(sha256(await readFile(join(root,n)))!==h)fail('FROZEN_INPUT_CHANGED',n);}

export function validateLabel(source,translation){
  if(typeof translation!=='string'||!translation.trim()||translation.length>Math.max(2000,source.length*4)
    ||/[⟦⟧]/.test(translation)||/<\/?[a-z][^>]*>/i.test(translation))fail('INVALID_LABEL','Label must remain nonempty plain data, without HTML or chapter markers.');
}
export function createFullSitePlan(catalog,retainedSources){
  validateUnitCatalog(catalog);
  const ordered=[...new Map(catalog.units.map(u=>[u.source,u])).values()];
  // Preserve the first catalog occurrence rather than the last duplicate mapping.
  const seen=new Set(), bodies=catalog.units.filter(u=>{if(seen.has(u.source))return false;seen.add(u.source);return true;});
  const labels=catalog.source.filter(s=>!isChapterSource(s));
  if(ordered.length!==562||catalog.units.length!==572||labels.length!==1338||catalog.source.length!==1900
    ||retainedSources.size!==450||[...retainedSources].some(s=>!seen.has(s)))fail('SOURCE_COUNTS_CHANGED','Expected 450 retained, 562 unique body, 572 mappings and 1338 independent labels.');
  const terms=new Map(TERMINOLOGY.terms.flatMap(t=>t.english.map(alias=>[normalize(alias),{translation:t.simplified,alias}])));
  const words=new Map(Object.entries(dictionary).map(([key,pair])=>[normalize(key),{key,translation:pair[0]}]));
  const prefill=[], pending=[];
  for(const source of labels){
    const term=terms.get(normalize(source)),word=words.get(normalize(source));
    if(term||word){const translation=term?.translation??word.translation;validateLabel(source,translation);
      prefill.push({source,sourceHash:sha256(source),translation,translationHash:sha256(translation),
        provenance:term?{type:'frozen-terminology-normalized-match',matchedSource:term.alias}:{type:'frozen-dictionary-normalized-match',matchedSource:word.key},
        exactDictionaryMatch:Object.hasOwn(dictionary,source)});
    }else pending.push(source);
  }
  const jobs=bodies.filter(u=>!retainedSources.has(u.source)).map(u=>({kind:'body',unitId:u.id,texts:[u.source],contexts:[`Complete chapter: ${u.title}. Genre code: ${u.genreId??u.id}. Registry: ${sha256(JSON.stringify(catalog))}.`]}));
  let batch=[],chars=0;
  const flush=()=>{if(batch.length){jobs.push({kind:'labels',texts:batch,contexts:batch.map(()=>'' )});batch=[];chars=0;}};
  for(const text of pending){if(text.length>5000)fail('LABEL_TOO_LONG','A source exceeds the unchanged per-text limit.');if(batch.length===20||chars+text.length>14000)flush();batch.push(text);chars+=text.length;}flush();
  jobs.forEach((j,i)=>{j.jobId=`${j.kind}-${i+1}`;j.sourceHashes=j.texts.map(sha256);j.sourceHash=sha256(JSON.stringify(j.texts));});
  return {prefill,jobs,counts:{bodyTotal:562,bodyMappings:572,labels:1338,total:1900,retainedBody:450,remainingBody:112,
    exactDictionary:labels.filter(s=>Object.hasOwn(dictionary,s)).length,normalizedDictionary:labels.filter(s=>words.has(normalize(s))).length,
    normalizedTerminology:labels.filter(s=>terms.has(normalize(s))).length,prefill:prefill.length,pendingLabels:pending.length,
    bodyRequests:jobs.filter(j=>j.kind==='body').length,labelRequests:jobs.filter(j=>j.kind==='labels').length,maxAttempts:jobs.length}};
}

// This branch has no automatic retry. It requires an explicit approved, hash-bound
// amendment for the single stopped #38; a pending proposal is never a permit.
const REVIEWED_REQUEST_38='c5e5aaea-92a9-41cf-9892-18bbfdf3646f';
export function applyFullSiteReplacement(basePlan,permit){
  if(!permit)return basePlan;
  if(permit.approval!=='approved-human-decision'||!permit.humanOriginalQuote?.trim()
    ||permit.originalOrdinal!==38||permit.originalRequestId!==REVIEWED_REQUEST_38
    ||permit.originalUnitId!==basePlan.jobs[37]?.unitId||basePlan.jobs[37]?.kind!=='body'
    ||permit.originalSourceHash!==sha256(basePlan.jobs[37].texts[0])
    ||permit.originalRequestSourceHash!==basePlan.jobs[37].sourceHash
    ||permit.oldAttemptLimit!==171||basePlan.counts.maxAttempts!==171
    ||permit.newAttemptLimit!==172||permit.newHistoryLimit!==613
    ||permit.replacementCount!==1||permit.possibleDuplicateCharge!==true
    ||!/^\w[\w./-]+$/.test(permit.approvalFile??'')||permit.approvalFile.includes('..')
    ||![permit.approvalHash,permit.originalJournalHash].every(h=>/^[a-f0-9]{64}$/.test(h??'')))
    fail('RESUBMISSION_NOT_AUTHORIZED','Only the specifically approved stopped request #38 may receive one new ID.');
  const clone={...basePlan.jobs[37],jobId:'body-38-reviewed-replacement',supersedesRequestId:permit.originalRequestId};
  return {...basePlan,jobs:[...basePlan.jobs.slice(0,38),clone,...basePlan.jobs.slice(38)],
    counts:{...basePlan.counts,bodyRequests:113,maxAttempts:172}};
}
export function isReviewedFullUnknown(attempt,manifest){
  const p=manifest.authorizedUnknownReplacement;
  return !!p&&attempt.ordinal===p.originalOrdinal&&attempt.requestId===p.originalRequestId
    &&attempt.jobId===manifest.plan.jobs[37].jobId&&attempt.sourceHash===p.originalRequestSourceHash
    &&attempt.state==='unknown'&&attempt.journalFile===p.originalJournalFile;
}
export function verifyReviewedFullUnknown(record,manifest,attempt,journalHash){
  const p=manifest.authorizedUnknownReplacement,j=manifest.plan.jobs[37];
  if(!isReviewedFullUnknown(attempt,manifest)||journalHash!==p.originalJournalHash
    ||record.requestId!==p.originalRequestId||record.type!=='failed'||record.errorCode!=='API_CONNECTION_FAILED'
    ||record.requestSent!==true||record.rawUsage!==null||record.returnedModel!==null||record.httpStatus!==null
    ||record.finishReason!==null||record.responseText!=null||record.translations!=null
    ||record.model!=='deepseek-v4-pro'||record.reasoningEffort!=='max'||record.maxTokens!==32768||record.timeoutMs!==600000
    ||record.sourceCount!==1||record.sourceHash!==j.sourceHash||!same(record.textHashes,j.sourceHashes)
    ||!same(record.contextHashes,j.contexts.map(sha256))||record.language!=='zh-Hans'
    ||record.promptTemplateHash!==CHAPTER_PROMPT_TEMPLATE_HASH||record.terminologyHash!==SIMPLIFIED_TERMINOLOGY_HASH
    ||record.identity?.continuation!==FULL_ID||record.identity?.kind!=='body'||record.identity?.jobId!==j.jobId
    ||record.identity?.catalogHash!==manifest.catalogHash||record.identity?.sourceHash!==manifest.sourceHash
    ||record.identity?.terminologyHash!==TERMINOLOGY_HASH||record.identityHash!==sha256(JSON.stringify(record.identity)))
    fail('REVIEWED_UNKNOWN_CHANGED','Approved unknown must remain byte-identical, null-usage and outside successful coverage.');
}

export function validateFullLedger(ledger,manifest){
  if(ledger.id!==FULL_ID||ledger.run!==FULL_RUN||ledger.maxAttempts!==manifest.plan.counts.maxAttempts||ledger.target!==1900
    ||ledger.priorAttempts!==441||!Array.isArray(ledger.attempts)||ledger.attempts.length>ledger.maxAttempts)fail('LEDGER_INVALID','Persistent quota or identity changed.');
  const ids=new Set();for(const[aIndex,a]of ledger.attempts.entries()){
    const j=manifest.plan.jobs[aIndex];
    if(!j||a.ordinal!==aIndex+1||a.historyOrdinal!==442+aIndex||a.jobId!==j.jobId||a.kind!==j.kind||a.sourceHash!==j.sourceHash
      ||a.supersedesRequestId!==j.supersedesRequestId
      ||a.deferredFromRequestId!==j.deferredFromRequestId||a.deferredSourceIndex!==j.deferredSourceIndex||!same(a.reviewedDeferredSources,j.reviewedDeferredSources)
      ||(j.supersedesRequestId&&a.requestId===j.supersedesRequestId)
      ||!['reserved','started','completed','recovered-partial','failed','unknown','not-sent'].includes(a.state))fail('LEDGER_INVALID','Attempt order, source or state changed.');
    if(a.requestId){if(ids.has(a.requestId))fail('LEDGER_INVALID','Duplicate request ID.');ids.add(a.requestId);}
  }
}
export function nextFullJob(ledger,manifest,completed){
  validateFullLedger(ledger,manifest);
  if(completed.size>1900)fail('TARGET_EXCEEDED','Source target exceeded.');
  if(completed.size===1900||ledger.attempts.length===ledger.maxAttempts)return null;
  if(ledger.state==='review-required'||ledger.attempts.some(a=>a.state!=='completed'&&!isReviewedFullUnknown(a,manifest)&&!isReviewedPartialLabel(a,manifest)))fail('REVIEW_REQUIRED','Unknown or failed reservation blocks all new spending.');
  const job=manifest.plan.jobs[ledger.attempts.length];
  if(job.texts.some(s=>completed.has(s)))fail('DUPLICATE_SPENDING','Already proven source selected for another paid attempt.');
  return job;
}
export function verifyFullRequest(record,manifest,job,{completed=true}={}){
  const template=job.kind==='body'?CHAPTER_PROMPT_TEMPLATE_HASH:TRANSLATION_PROMPT_TEMPLATE_HASH;
  if(!record||record.type!==(completed?'completed':'failed')||record.model!=='deepseek-v4-pro'||record.returnedModel!=='deepseek-v4-pro'
    ||(record.returnedEffort&&record.returnedEffort!=='max')||record.reasoningEffort!=='max'||record.maxTokens!==32768||record.timeoutMs!==600000
    ||record.language!=='zh-Hans'||record.httpStatus!==200||record.finishReason!=='stop'||!knownUsage(record)||record.requestSent!==true
    ||record.sourceCount!==job.texts.length||record.sourceHash!==job.sourceHash||!same(record.textHashes,job.sourceHashes)
    ||!same(record.contextHashes,job.contexts.map(sha256))||record.promptTemplateHash!==template||record.terminologyHash!==SIMPLIFIED_TERMINOLOGY_HASH
    ||record.identity?.continuation!==FULL_ID||record.identity?.kind!==job.kind||record.identity?.jobId!==job.jobId
    ||record.identity?.catalogHash!==manifest.catalogHash||record.identity?.sourceHash!==manifest.sourceHash||record.identity?.terminologyHash!==TERMINOLOGY_HASH
    ||record.identity?.supersedesRequestId!==job.supersedesRequestId
    ||record.identity?.deferredFromRequestId!==job.deferredFromRequestId||record.identity?.deferredSourceIndex!==job.deferredSourceIndex||!same(record.identity?.reviewedDeferredSources,job.reviewedDeferredSources)
    ||record.requestId===job.supersedesRequestId
    ||record.identityHash!==sha256(JSON.stringify(record.identity)))fail('USAGE_OR_IDENTITY_INVALID','Full-site journal does not match its frozen request, model and known usage.');
  if(completed){
    if(record.translations?.length!==job.texts.length)fail('OUTPUT_COUNT_INVALID','Output count differs.');
    job.texts.forEach((s,i)=>job.kind==='body'?validateChapterTranslation(s,record.translations[i]):validateLabel(s,record.translations[i]));
  }
}
async function exportTexts(workspace,catalog,texts,translations){
  const groups=new Map();texts.forEach((s,i)=>{const index=shardForText(s,8);if(!groups.has(index))groups.set(index,[]);groups.get(index).push([s,translations[i]]);});
  for(const[index,entries]of groups){const file=join(workspace,`generated/shards/zh-Hans-${index}-of-8.json`),wrapper=await readJson(file);
    validateShardWrapper(wrapper,{sourceHash:catalog.sourceHash,source:catalog.source,shard:{index,count:8}});
    for(const[s,t]of entries){if(Object.hasOwn(wrapper.translations,s)&&wrapper.translations[s]!==t)fail('EXPORT_CONFLICT','Different translation already exported.');wrapper.translations[s]=t;}
    await atomicJson(file,wrapper);
  }
}
async function checkExports(workspace,catalog,expected){
  const actual=new Map();for(let i=1;i<=8;i++){const w=await readJson(join(workspace,`generated/shards/zh-Hans-${i}-of-8.json`));validateShardWrapper(w,{sourceHash:catalog.sourceHash,source:catalog.source,shard:{index:i,count:8}});
    for(const[s,t]of Object.entries(w.translations)){if(actual.has(s))fail('DUPLICATE_EXPORT','Source exported twice.');actual.set(s,t);}}
  if(actual.size!==expected.size||[...actual].some(([s,t])=>expected.get(s)!==t))fail('UNPROVEN_EXPORT','Only proven retained, dictionary and new paid outputs may be exported.');
}
export async function prepareFullSite({rootDir=PROJECT_ROOT}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');try{
    if(await optionalJson(join(rootDir,FULL_LEDGER))){await loadFullSite(rootDir);return readFullSiteStatus({rootDir});}
    const authorization=await readJson(join(rootDir,FULL_AUTH));
    if(authorization.visibleOriginalUserQuote!=='推進到全部完成並同步github'||authorization.coordinatorBoundary?.total!==1900
      ||authorization.coordinatorBoundary?.bodyTotal!==562||authorization.coordinatorBoundary?.labels!==1338)fail('AUTHORIZATION_INVALID','Full-site authorization differs.');
    const parent=await auditFullSiteParent(rootDir),plan=createFullSitePlan(parent.catalog,new Set(parent.translations.keys()));
    const run=join(rootDir,FULL_RUN),workspace=join(run,'workspace');
    if(await stat(run).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}))fail('RUN_EXISTS','Unaccounted run exists; never reset a quota.');
    await mkdir(workspace,{recursive:true});
    await cp(join(rootDir,PARENT_RUN),join(run,'parent-snapshot/run'),{recursive:true});
    await cp(join(rootDir,'generated/production/chapter-continuation-80pct.json'),join(run,'parent-snapshot/live-ledger.json'));
    const parentTree=await treeHashes(join(rootDir,PARENT_RUN));
    const snapshotTree=await treeHashes(join(run,'parent-snapshot/run'));assert.deepEqual(snapshotTree,parentTree);
    for(const dir of ['lib','scripts','public','data','benchmarks'])await cp(join(rootDir,dir),join(workspace,dir),{recursive:true});
    for(const dir of ['generated/site','.cache/source'])await cp(join(parent.workspace,dir),join(workspace,dir),{recursive:true});
    for(const file of ['package.json','package-lock.json','server.mjs'])await cp(join(rootDir,file),join(workspace,file));
    for(const index of [1,2,3,4,5,6,7,8])await atomicJson(join(workspace,`generated/shards/zh-Hans-${index}-of-8.json`),{sourceHash:parent.catalog.sourceHash,language:'zh-Hans',shard:{index,count:8},translations:{}});
    await atomicJson(join(workspace,'generated/production/chapter-pilot-policy.json'),{id:FULL_ID,retiredFragmentEntry:true,maxAttempts:plan.counts.maxAttempts});
    for(const r of parent.retained)await exportTexts(workspace,parent.catalog,[r.source],[r.translation]);
    await exportTexts(workspace,parent.catalog,plan.prefill.map(p=>p.source),plan.prefill.map(p=>p.translation));
    const inputs=Object.fromEntries(Object.entries(parent.manifest.inputs).filter(([name])=>name.startsWith('.cache/source/')||name.startsWith('generated/site/')));
    const manifest={schemaVersion:1,id:FULL_ID,createdAt:now(),authorization,config:{...PILOT_CONFIG,maxAttempts:plan.counts.maxAttempts},
      plan,retained:parent.retained,parentRun:PARENT_RUN,parentTree,parentSnapshotTree:snapshotTree,parentAudit:parent.audit,historicalEvidence:parent.manifest.priorEvidence,
      sourceHash:parent.catalog.sourceHash,catalogHash:sha256(JSON.stringify(parent.catalog)),terminologyHash:TERMINOLOGY_HASH,
      chapterPromptHash:CHAPTER_PROMPT_TEMPLATE_HASH,labelPromptHash:TRANSLATION_PROMPT_TEMPLATE_HASH,authSourceFile:parent.manifest.authSourceFile,
      inputs,program:await fileHashes(rootDir,FULL_PROGRAM),automaticPaidRetries:0,historyAttemptLimit:441+plan.counts.maxAttempts};
    await atomicJson(join(run,'authorization.json'),authorization);await atomicJson(join(run,'parent-verification.json'),parent.audit);
    await atomicJson(join(run,'manifest.json'),manifest);
    const ledger={schemaVersion:1,id:FULL_ID,run:FULL_RUN,manifestHash:sha256(await readFile(join(run,'manifest.json'))),target:1900,
      maxAttempts:plan.counts.maxAttempts,priorAttempts:441,historyAttemptLimit:manifest.historyAttemptLimit,state:'prepared',createdAt:now(),attempts:[]};
    await atomicJson(join(rootDir,FULL_LEDGER),ledger);await atomicJson(join(run,'quota-ledger.json'),ledger);
    await loadFullSite(rootDir);return readFullSiteStatus({rootDir});
  }finally{await release();}
}
async function loadFullSite(root){
  const run=join(root,FULL_RUN),workspace=join(run,'workspace'),ledger=await readJson(join(root,FULL_LEDGER)),bytes=await readFile(join(run,'manifest.json')),manifest=JSON.parse(bytes);
  if(sha256(bytes)!==ledger.manifestHash||manifest.id!==FULL_ID||manifest.chapterPromptHash!==CHAPTER_PROMPT_TEMPLATE_HASH||manifest.labelPromptHash!==TRANSLATION_PROMPT_TEMPLATE_HASH
    ||manifest.terminologyHash!==TERMINOLOGY_HASH||manifest.config.model!=='deepseek-v4-pro'||manifest.config.reasoningEffort!=='max'||manifest.config.maxTokens!==32768
    ||manifest.config.thinking!=='enabled'||manifest.automaticPaidRetries!==0)fail('MANIFEST_INVALID','Frozen full-site manifest differs.');
  assert.deepEqual(Object.keys(manifest.program),FULL_PROGRAM,'Full program freeze is required');
  validateFullLedger(ledger,manifest);await verifyHashes(root,manifest.program);await verifyHashes(workspace,{...manifest.program,...manifest.inputs});
  assert.deepEqual(await treeHashes(join(root,PARENT_RUN)),manifest.parentTree,'Parent run tree changed after freeze');
  assert.deepEqual(await treeHashes(join(run,'parent-snapshot/run')),manifest.parentSnapshotTree,'Parent snapshot changed');
  assert.equal(sha256(await readFile(join(root,'generated/production/chapter-continuation-80pct.json'))),manifest.parentAudit.parentLedgerHash);
  await verifyHashes(root,manifest.historicalEvidence??{});
  await verifyHashes(root,Object.fromEntries(manifest.retained.flatMap(r=>[[r.journalFile,r.journalHash],...(r.recoveryFile?[[r.recoveryFile,r.recoveryHash]]:[]),...(r.reviewedCorrection?[[r.reviewedCorrection.file,r.reviewedCorrection.sha256]]:[])])));
  if(manifest.parentAudit.oldUnknown){const old=manifest.parentAudit.oldUnknown,bytes=await readFile(join(root,old.journalFile));assert.equal(sha256(bytes),old.journalHash);assert.equal(JSON.parse(bytes).rawUsage,null);}
  const catalog=validateUnitCatalog(await readJson(join(workspace,'.cache/source/units.json')));
  assert.equal(sha256(JSON.stringify(catalog)),manifest.catalogHash);assert.equal(catalog.sourceHash,manifest.sourceHash);
  assert.deepEqual(applyReviewedLabelDeferrals(applyFullSiteReplacement(createFullSitePlan(catalog,new Set(manifest.retained.map(r=>r.source))),manifest.authorizedUnknownReplacement),manifest),manifest.plan);
  for(const d of labelDeferralReviews(manifest)){assert.equal(manifest.inputs[d.reviewFile],d.reviewHash);const {reviewHash,...review}=d;assert.deepEqual(await readJson(join(workspace,d.reviewFile)),review);if(ledger.attempts.length<d.ordinal)fail('LABEL_DEFERRAL_INVALID','Reviewed omitted output must already have a reserved original request.');}
  if(manifest.authorizedUnknownReplacement){const p=manifest.authorizedUnknownReplacement;assert.equal(manifest.inputs[p.approvalFile],p.approvalHash);const approval=await readJson(join(workspace,p.approvalFile));const {approvalHash,...policy}=p;assert.deepEqual(approval,policy);assert.equal(manifest.config.maxAttempts,172);assert.equal(manifest.historyAttemptLimit,613);assert.equal(ledger.historyAttemptLimit,613);}
  return {root,run,workspace,ledger,manifest,catalog};
}
async function acceptRecovered(loaded,attempt,job,record){
  verifyFullRequest(record,loaded.manifest,job,{completed:false});
  if(job.kind!=='body')return null;
  let candidate=formatRecovery.recoverChapterFormat(job.texts[0],record.responseText);
  const reviewed=loaded.manifest.reviewedFormatCorrections?.find(p=>p.requestId===record.requestId);
  if(!candidate&&reviewed){
    const bytes=await readFile(join(loaded.workspace,reviewed.file)),proof=JSON.parse(bytes);
    assert.equal(sha256(bytes),reviewed.sha256);assert.equal(proof.originalJournalHash,sha256(await readFile(join(loaded.workspace,attempt.journalFile))));
    assert.equal(proof.originalResponseHash,sha256(record.responseText));assert.equal(proof.requestId,record.requestId);assert.equal(proof.unitId,job.unitId);assert.equal(proof.sourceHash,sha256(job.texts[0]));
    for(const fn of ['recoverReviewedDuplicateBold','recoverReviewedMissingBold','recoverReviewedMissingBoldPair','recoverReviewedMissingBoldOpen','recoverReviewedMissingNestedBold','recoverReviewedParagraphBoundaries'])candidate??=formatRecovery[fn](loaded.catalog.units.find(u=>u.id===job.unitId),record.responseText,proof);
    candidate??=recoverReviewedLinkedTitleBold(loaded.catalog.units.find(u=>u.id===job.unitId),record.responseText,proof);
    if(!candidate||sha256(candidate.translation)!==proof.expectedCandidateHash)fail('REVIEWED_CORRECTION_INVALID','Exact reviewed candidate cannot be reproduced by the original validator.');
    candidate.reviewedCorrectionFile=reviewed.file;
  }
  if(!candidate)return null;
  const file=`generated/translation-recoveries/${record.requestId}.json`,evidence={type:'local-format-recovery',continuation:FULL_ID,requestId:record.requestId,
    unitId:job.unitId,sourceHash:sha256(job.texts[0]),originalJournalFile:attempt.journalFile,originalJournalHash:sha256(await readFile(join(loaded.workspace,attempt.journalFile))),...candidate};
  const previous=await optionalJson(join(loaded.workspace,file));if(previous&&!same(previous,evidence))fail('RECOVERY_CHANGED','Recovery sidecar changed.');
  if(!previous)await atomicJson(join(loaded.workspace,file),evidence);
  attempt.recoveryFile=file;attempt.originalFailure=record.errorCode;attempt.recoveryKind=candidate.kind;return [candidate.translation];
}
async function reconcileFullSite(loaded){
  const {manifest,ledger,workspace,catalog}=loaded;
  const expected=new Map([...manifest.retained.map(r=>[r.source,r.translation]),...manifest.plan.prefill.map(p=>[p.source,p.translation])]);
  for(const r of manifest.retained){assert.equal(sha256(r.translation),r.translationHash);validateChapterTranslation(r.source,r.translation);}
  for(const a of ledger.attempts){const job=manifest.plan.jobs[a.ordinal-1];
    const record=a.journalFile?await optionalJson(join(workspace,a.journalFile)):null;
    if(!record||record.requestId!==a.requestId){a.state='unknown';fail('UNKNOWN_ATTEMPT','A reserved request has no certain journal; no automatic resend.');}
    if(isReviewedFullUnknown(a,manifest)){verifyReviewedFullUnknown(record,manifest,a,sha256(await readFile(join(workspace,a.journalFile))));continue;}
    const labelReview=labelDeferralReviewFor(manifest,record.requestId);
    if(labelReview){
      verifyFullRequest(record,manifest,job,{completed:false});
      const candidate=recoverReviewedPartialLabels(job,record,labelReview,sha256(await readFile(join(workspace,a.journalFile))),validateLabel);
      const file=`generated/translation-recoveries/${record.requestId}.json`,evidence={type:'reviewed-partial-label-recovery',continuation:FULL_ID,requestId:record.requestId,sourceHash:job.sourceHash,originalJournalFile:a.journalFile,originalJournalHash:labelReview.originalJournalHash,...candidate};
      const previous=await optionalJson(join(workspace,file));if(previous&&!same(previous,evidence))fail('RECOVERY_CHANGED','Partial label recovery changed.');if(!previous)await atomicJson(join(workspace,file),evidence);
      const texts=candidate.sourceIndices.map(i=>job.texts[i]);texts.forEach((s,i)=>{if(expected.has(s))fail('DUPLICATE_EXPORT','Partial output source already accepted.');expected.set(s,candidate.translations[i]);});
      await exportTexts(workspace,catalog,texts,candidate.translations);a.recoveryFile=file;a.recoveryKind=candidate.kind;a.originalFailure=record.errorCode;a.recoveredSourceIndices=candidate.sourceIndices;a.state='recovered-partial';continue;
    }
    let translations;
    if(record.type==='completed'){verifyFullRequest(record,manifest,job);translations=record.translations;}
    else if(record.type==='failed'&&['INVALID_TRANSLATION','INVALID_CHAPTER_STRUCTURE','INCOMPLETE_TRANSLATION'].includes(record.errorCode)){
      translations=await acceptRecovered(loaded,a,job,record);if(!translations){a.state='failed';fail('FORMAT_REVIEW_REQUIRED','Known paid output needs diagnosis; no automatic paid retry.');}
    }else{a.state='unknown';fail('UNKNOWN_ATTEMPT','Unknown usage/model/result must stop.');}
    job.texts.forEach((s,i)=>expected.set(s,translations[i]));await exportTexts(workspace,catalog,job.texts,translations);a.state='completed';
  }
  await checkExports(workspace,catalog,expected);return expected;
}
export async function readFullSiteStatus({rootDir=PROJECT_ROOT}={}){
  const ledger=await optionalJson(join(rootDir,FULL_LEDGER));if(!ledger)return {state:'not-prepared',target:1900};
  const manifest=await readJson(join(rootDir,FULL_RUN,'manifest.json'));validateFullLedger(ledger,manifest);
  const accepted=ledger.attempts.filter(a=>a.state==='completed');
  return {id:FULL_ID,state:ledger.state,bodyCompleted:450+accepted.filter(a=>a.kind==='body').length,bodyTotal:562,
    labelsCompleted:manifest.plan.counts.prefill+accepted.filter(a=>a.kind==='labels').reduce((n,a)=>n+manifest.plan.jobs[a.ordinal-1].texts.length,0)+ledger.attempts.filter(a=>isReviewedPartialLabel(a,manifest)).reduce((n,a)=>n+a.recoveredSourceIndices.length,0),labelsTotal:1338,
    counts:manifest.plan.counts,newAttempts:ledger.attempts.length,maxAttempts:ledger.maxAttempts,historyAttempts:441+ledger.attempts.length,
    recovered:ledger.attempts.filter(a=>a.recoveryFile).length,reviewedUnknown:ledger.attempts.filter(a=>isReviewedFullUnknown(a,manifest)).length,unknown:ledger.attempts.filter(a=>a.state==='unknown').length,unresolved:ledger.attempts.filter(a=>a.state!=='completed'&&!isReviewedFullUnknown(a,manifest)&&!isReviewedPartialLabel(a,manifest)).length,lastError:ledger.lastError??null,run:FULL_RUN};
}
export async function executeFullSite({rootDir=PROJECT_ROOT,apiKey,fetchImpl=globalThis.fetch,manageSignals=true,shouldStop=()=>false,afterJournal=async()=>{},log=console.log}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');let stopping=false;const stop=()=>{stopping=true;log('Stop requested; finish this single request, then stop.');};
  if(manageSignals){process.on('SIGINT',stop);process.on('SIGTERM',stop);}
  try{
    const loaded=await loadFullSite(rootDir),{manifest,ledger,run,workspace,catalog}=loaded;
    const save=async()=>{ledger.updatedAt=now();await atomicJson(join(rootDir,FULL_LEDGER),ledger);await atomicJson(join(run,'quota-ledger.json'),ledger);};
    let completed;try{completed=await reconcileFullSite(loaded);}catch(e){ledger.state='review-required';ledger.lastError=e.code??'LOCAL_FAILURE';await save();throw e;}
    await save();if(ledger.state==='review-required')fail('REVIEW_REQUIRED','Persisted review-required stop needs offline recovery, never automatic paid resend.');
    const finish=async()=>{ledger.state=completed.size===1900?'target-reached':ledger.attempts.length===ledger.maxAttempts?'quota-exhausted-shortfall':'paused';await save();
      await atomicJson(join(run,'stop-marker.json'),{id:FULL_ID,stoppedAt:now(),state:ledger.state,totalCompleted:completed.size,target:1900,newAttempts:ledger.attempts.length,maxAttempts:ledger.maxAttempts,automaticPaidRetries:0});return readFullSiteStatus({rootDir});};
    if(!nextFullJob(ledger,manifest,completed))return finish();
    const key=await readTranslationKey({apiKey,apiKeyFile:apiKey===undefined?manifest.authSourceFile:undefined});if(!key)fail('API_KEY_MISSING','Translation key missing.');
    ledger.state='running';await save();
    while(!stopping&&!shouldStop()){
      const job=nextFullJob(ledger,manifest,completed);if(!job)break;
      await verifyHashes(rootDir,manifest.program);
      const ordinal=ledger.attempts.length+1,scope=`full-${ordinal}-${job.kind}`;
      const identity={continuation:FULL_ID,kind:job.kind,jobId:job.jobId,sourceHash:manifest.sourceHash,catalogHash:manifest.catalogHash,
        model:'deepseek-v4-pro',reasoningEffort:'max',maxTokens:32768,terminologyHash:TERMINOLOGY_HASH,
        promptTemplateHash:job.kind==='body'?CHAPTER_PROMPT_TEMPLATE_HASH:TRANSLATION_PROMPT_TEMPLATE_HASH,
        ...(job.supersedesRequestId?{supersedesRequestId:job.supersedesRequestId}:{}),
        ...(job.deferredFromRequestId?{deferredFromRequestId:job.deferredFromRequestId,deferredSourceIndex:job.deferredSourceIndex,reviewedDeferredSources:job.reviewedDeferredSources}:{})};
      const journal=await createTranslationJournal({rootDir:workspace,scope,identity,source:job.texts});
      if(Object.keys(journal.recovered).length)fail('UNRESERVED_JOURNAL','A result exists without a reservation.');
      const attempt={ordinal,historyOrdinal:441+ordinal,jobId:job.jobId,kind:job.kind,sourceHash:job.sourceHash,state:'reserved',reservedAt:now(),requestId:null,journalFile:null,
        ...(job.supersedesRequestId?{supersedesRequestId:job.supersedesRequestId}:{}),
        ...(job.deferredFromRequestId?{deferredFromRequestId:job.deferredFromRequestId,deferredSourceIndex:job.deferredSourceIndex,reviewedDeferredSources:job.reviewedDeferredSources}:{})};
      ledger.attempts.push(attempt);await save();let record=null;
      try{
        const translator=createTranslator({...PILOT_CONFIG,apiKey:key,fetchImpl,unitProtocol:job.kind==='body'?PILOT_CONFIG.unitProtocol:null,
          requireKnownUsage:true,cacheDir:join(workspace,'.cache/full-site-translations'),shouldStop:()=>stopping||shouldStop(),
          onRequest:async event=>{if(event.type==='started'){if(attempt.requestId!==null)fail('REQUEST_LIMIT','One reservation permits exactly one API request.');attempt.requestId=event.requestId;attempt.journalFile=`generated/translation-requests/${scope}/${event.requestId}.json`;attempt.state='started';await save();}
            await journal.record(event);if(event.type!=='started')record=await readJson(join(workspace,attempt.journalFile));}});
        const result=await translator.translate({language:'zh-Hans',texts:job.texts,contexts:job.contexts});
        if(result.cached||!record)fail('UNEXPECTED_CACHE','New output must have a durable new journal.');
        verifyFullRequest(record,manifest,job);await afterJournal({ordinal,record});await exportTexts(workspace,catalog,job.texts,result.translations);
        job.texts.forEach((s,i)=>completed.set(s,result.translations[i]));attempt.state='completed';attempt.finishedAt=now();await save();
        log(`${now()} Sources ${completed.size}/1900; request ${ordinal}/${ledger.maxAttempts} ${job.unitId??job.jobId}: completed; ${record.normalizedUsage.total} tokens.`);
      }catch(error){
        attempt.errorCode=error.code??'LOCAL_FAILURE';attempt.finishedAt=now();
        if(record?.type==='failed'&&['INVALID_TRANSLATION','INVALID_CHAPTER_STRUCTURE','INCOMPLETE_TRANSLATION'].includes(record.errorCode)){
          try{const translations=await acceptRecovered(loaded,attempt,job,record);if(translations){await exportTexts(workspace,catalog,job.texts,translations);job.texts.forEach((s,i)=>completed.set(s,translations[i]));attempt.state='completed';await save();log(`${now()} Sources ${completed.size}/1900; request ${ordinal}/${ledger.maxAttempts}: local recovery; failed journal retained; no new call.`);continue;}
            attempt.state='failed';ledger.lastError='FORMAT_REVIEW_REQUIRED';
          }catch(e){attempt.state='unknown';ledger.lastError=e.code??'RECOVERY_FAILED';}
        }else{attempt.state=record?.type==='completed'?'started':'unknown';ledger.lastError=attempt.errorCode;}
        ledger.state='review-required';await save();throw error;
      }
    }
    await checkExports(workspace,catalog,completed);return finish();
  }finally{if(manageSignals){process.off('SIGINT',stop);process.off('SIGTERM',stop);}await release();}
}
export async function recoverFullSite({rootDir=PROJECT_ROOT}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');try{
    const loaded=await loadFullSite(rootDir);if(loaded.ledger.state!=='review-required')fail('RECOVERY_NOT_ALLOWED','Only a stopped run may be reconciled.');
    const completed=await reconcileFullSite(loaded);if(loaded.ledger.attempts.some(a=>a.state!=='completed'&&!isReviewedFullUnknown(a,loaded.manifest)&&!isReviewedPartialLabel(a,loaded.manifest)))fail('RECOVERY_INCOMPLETE','Unresolved paid request persists.');
    loaded.ledger.state=completed.size===1900?'target-reached':'paused';loaded.ledger.lastError=null;loaded.ledger.updatedAt=now();
    await atomicJson(join(rootDir,FULL_LEDGER),loaded.ledger);await atomicJson(join(loaded.run,'quota-ledger.json'),loaded.ledger);return readFullSiteStatus({rootDir});
  }finally{await release();}
}
export async function registerFullSiteReview({rootDir=PROJECT_ROOT,proofFile}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');try{
    const loaded=await loadFullSite(rootDir),{manifest,ledger,run,workspace}=loaded;
    if(ledger.state!=='review-required')fail('REVIEW_NOT_ALLOWED','Only a stopped, known failed body output may receive an exact review proof.');
    const bytes=await readFile(proofFile),proof=JSON.parse(bytes),a=ledger.attempts.find(a=>a.requestId===proof.requestId),job=a&&manifest.plan.jobs[a.ordinal-1];
    if(!a||job.kind!=='body')fail('REVIEW_NOT_ALLOWED','Review proof must bind a paid body request in this run.');
    const record=await readJson(join(workspace,a.journalFile));verifyFullRequest(record,manifest,job,{completed:false});
    assert.equal(proof.originalJournalHash,sha256(await readFile(join(workspace,a.journalFile))));assert.equal(proof.originalResponseHash,sha256(record.responseText));assert.equal(proof.sourceHash,sha256(job.texts[0]));assert.equal(proof.unitId,job.unitId);
    const file=`data/reviewed-format-corrections/${record.requestId}.json`;
    const prior=manifest.reviewedFormatCorrections?.find(p=>p.requestId===record.requestId);if(prior){assert.equal(prior.sha256,sha256(bytes));return readFullSiteStatus({rootDir});}
    // Validate the prospective proof in memory before changing the frozen version.
    let candidate=null;for(const fn of ['recoverReviewedDuplicateBold','recoverReviewedMissingBold','recoverReviewedMissingBoldPair','recoverReviewedMissingBoldOpen','recoverReviewedMissingNestedBold','recoverReviewedParagraphBoundaries'])candidate??=formatRecovery[fn](loaded.catalog.units.find(u=>u.id===job.unitId),record.responseText,proof);
    candidate??=recoverReviewedLinkedTitleBold(loaded.catalog.units.find(u=>u.id===job.unitId),record.responseText,proof);
    assert.ok(candidate);assert.equal(sha256(candidate.translation),proof.expectedCandidateHash);validateChapterTranslation(job.texts[0],candidate.translation);
    const history=join(run,'manifest-history',`before-review-${a.ordinal}-${Date.now()}`);await mkdir(history,{recursive:true});
    await cp(join(run,'manifest.json'),join(history,'manifest.json'));await cp(join(rootDir,FULL_LEDGER),join(history,'live-ledger.json'));await cp(join(run,'quota-ledger.json'),join(history,'quota-ledger.json'));
    await mkdir(join(workspace,'data/reviewed-format-corrections'),{recursive:true});await cp(proofFile,join(workspace,file));
    manifest.reviewedFormatCorrections=[...(manifest.reviewedFormatCorrections??[]),{requestId:record.requestId,file,sha256:sha256(bytes)}];manifest.inputs[file]=sha256(bytes);
    await atomicJson(join(run,'manifest.json'),manifest);ledger.manifestHash=sha256(await readFile(join(run,'manifest.json')));ledger.updatedAt=now();
    await atomicJson(join(rootDir,FULL_LEDGER),ledger);await atomicJson(join(run,'quota-ledger.json'),ledger);
    await atomicJson(join(history,'review-amendment.json'),{recordedAt:now(),requestId:record.requestId,unitId:job.unitId,proofHash:sha256(bytes),candidateHash:sha256(candidate.translation),addedPaidRequests:0,capUnchanged:ledger.maxAttempts});
    return readFullSiteStatus({rootDir});
  }finally{await release();}
}
export async function registerFullSiteLabelDeferral({rootDir=PROJECT_ROOT,reviewFile}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');try{
    const loaded=await loadFullSite(rootDir),{manifest,ledger,run,workspace}=loaded;
    const bytes=await readFile(reviewFile),review=JSON.parse(bytes),file=`data/reviewed-label-deferrals/${review.requestId}.json`;
    const existing=labelDeferralReviewFor(manifest,review.requestId);if(existing){assert.equal(existing.reviewHash,sha256(bytes));return readFullSiteStatus({rootDir});}
    if(ledger.state!=='review-required'||![120,133,148].includes(review.ordinal)||ledger.attempts.length!==review.ordinal||review.reviewFile!==file)fail('LABEL_DEFERRAL_INVALID','Only the diagnosed stopped request120/133/148 and an unsent tail may be amended.');
    const a=ledger.attempts[review.ordinal-1],job=manifest.plan.jobs[review.ordinal-1],journalBytes=await readFile(join(workspace,a.journalFile)),record=JSON.parse(journalBytes);
    assert.equal(a.requestId,review.requestId);verifyFullRequest(record,manifest,job,{completed:false});
    const bound={...review,reviewHash:sha256(bytes)},plan=applyReviewedLabelDeferral(manifest.plan,bound);
    recoverReviewedPartialLabels(job,record,bound,sha256(journalBytes),validateLabel);
    assert.deepEqual(plan.jobs.slice(0,-1),manifest.plan.jobs.slice(0,-1));assert.equal(ledger.maxAttempts,172);assert.equal(ledger.historyAttemptLimit,613);
    const history=join(run,'manifest-history',`before-label-deferral${review.ordinal}-${Date.now()}`);await mkdir(history,{recursive:true});
    await cp(join(run,'manifest.json'),join(history,'manifest.json'));await cp(join(rootDir,FULL_LEDGER),join(history,'live-ledger.json'));await cp(join(run,'quota-ledger.json'),join(history,'quota-ledger.json'));
    await mkdir(join(workspace,'data/reviewed-label-deferrals'),{recursive:true});await cp(reviewFile,join(workspace,file));
    manifest[review.ordinal===120?'reviewedLabelDeferral':review.ordinal===133?'reviewedAdditionalLabelDeferral':'reviewedThirdLabelDeferral']=bound;manifest.inputs[file]=sha256(bytes);manifest.plan=plan;
    await atomicJson(join(run,'manifest.json'),manifest);ledger.manifestHash=sha256(await readFile(join(run,'manifest.json')));ledger.updatedAt=now();
    await atomicJson(join(rootDir,FULL_LEDGER),ledger);await atomicJson(join(run,'quota-ledger.json'),ledger);
    await atomicJson(join(history,'label-deferral-amendment.json'),{recordedAt:now(),requestId:review.requestId,reviewHash:sha256(bytes),retainedOutputCount:review.sourceIndexForEachOutput.length,omittedSourceIndices:review.missingSourceIndices??[review.missingSourceIndex],tailOldCount:plan.jobs.at(-1).texts.length-(review.missingSourceIndices?.length??1),tailNewCount:plan.jobs.at(-1).texts.length,capUnchanged:172,historyCapUnchanged:613,addedRequestReservations:0,originalFailedJobUnchanged:true,allPriorAttemptsUnchanged:true});
    return readFullSiteStatus({rootDir});
  }finally{await release();}
}
export async function buildFullSite({rootDir=PROJECT_ROOT}={}){
  const release=await acquireTranslationLock(rootDir,'chapter-pilot-control');try{
    const loaded=await loadFullSite(rootDir),{ledger,run,workspace,catalog,manifest}=loaded;
    if(ledger.state!=='target-reached')fail('BUILD_INCOMPLETE','All 1900 source keys must finish before formal build.');
    const completed=await reconcileFullSite(loaded);if(completed.size!==1900)fail('BUILD_INCOMPLETE','Formal build requires exact full coverage.');
    const {mergeTranslations}=await import('../scripts/merge-translations.mjs');const {convertToTraditional,hashLocale}=await import('./chinese-conversion.mjs');const {build}=await import('../scripts/build.mjs');
    await mergeTranslations({rootDir:workspace});await convertToTraditional({rootDir:workspace});const status=await build({projectRoot:workspace,allowPartial:false});
    const locales=await Promise.all(['zh-Hans','zh-Hant'].map(l=>readJson(join(workspace,`generated/locales/${l}.json`)))),conversion=await readJson(join(workspace,'generated/conversion-status.json'));
    for(const locale of locales){assert.equal(Object.keys(locale).length,1900);for(const s of catalog.source){assert.ok(locale[s]);if(isChapterSource(s))validateChapterTranslation(s,locale[s]);else validateLabel(s,locale[s]);}}
    assert.ok(status.languages['zh-Hans'].complete&&status.languages['zh-Hant'].complete&&conversion.complete);
    assert.equal(conversion.sourceHash,manifest.sourceHash);assert.equal(conversion.simplifiedHash,hashLocale(locales[0]));assert.equal(conversion.traditionalHash,hashLocale(locales[1]));assert.equal(conversion.terminologyHash,TERMINOLOGY_HASH);
    const evidence={passed:true,id:FULL_ID,builtAt:now(),bodyCompleted:562,bodyMappings:572,labelsCompleted:1338,totalCompleted:1900,partial:false,formalBuild:true,status,conversion,previewDirectory:`${FULL_RUN}/workspace/dist`,captionAdapterTracked:true,reportsCreated:false};
    await atomicJson(join(run,'build-verification.json'),evidence);return evidence;
  }finally{await release();}
}
