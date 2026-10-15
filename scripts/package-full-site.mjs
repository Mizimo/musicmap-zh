#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join,resolve,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FULL_RUN,FULL_LEDGER,FULL_ID,validateFullLedger,verifyFullRequest,validateLabel,createFullSitePlan,applyFullSiteReplacement,isReviewedFullUnknown,verifyReviewedFullUnknown } from '../lib/full-site.mjs';
import { sha256,treeHashes,readJson } from '../lib/full-site-parent.mjs';
import { validateUnitCatalog,validateChapterTranslation,isChapterSource } from '../lib/chapter-units.mjs';
import * as recovery from '../lib/chapter-format-recovery-80.mjs';
import { recoverReviewedLinkedTitleBold } from '../lib/full-site-format-recovery.mjs';
import {applyReviewedLabelDeferrals,labelDeferralReviews,labelDeferralReviewFor,isReviewedPartialLabel,recoverReviewedPartialLabels} from '../lib/full-site-label-recovery.mjs';
import { hashLocale,CONVERTER } from '../lib/chinese-conversion.mjs';
import { TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { prepareHTML,prepareBundle } from './build.mjs';
import { packageRelease } from './package-release.mjs';

/** Independent formal-run verifier; never rewrites legacy production state. */
export async function verifyFullSiteRelease({rootDir,run=FULL_RUN}={}){
  rootDir=resolve(rootDir??fileURLToPath(new URL('..',import.meta.url)));assert.equal(run,FULL_RUN);
  const directory=join(rootDir,run),ws=join(directory,'workspace'),manifestBytes=await readFile(join(directory,'manifest.json')),m=JSON.parse(manifestBytes),ledger=await readJson(join(rootDir,FULL_LEDGER));
  assert.equal(m.id,FULL_ID);assert.equal(sha256(manifestBytes),ledger.manifestHash);validateFullLedger(ledger,m);assert.equal(ledger.state,'target-reached');assert.ok(ledger.attempts.every(a=>a.state==='completed'||isReviewedFullUnknown(a,m)||isReviewedPartialLabel(a,m)));
  for(const[base,files]of [[rootDir,m.program],[ws,{...m.program,...m.inputs}],[rootDir,m.historicalEvidence]])for(const[file,digest]of Object.entries(files))assert.equal(sha256(await readFile(join(base,file))),digest,file);
  assert.deepEqual(await treeHashes(join(rootDir,m.parentRun)),m.parentTree);assert.deepEqual(await treeHashes(join(directory,'parent-snapshot/run')),m.parentSnapshotTree);
  const c=validateUnitCatalog(await readJson(join(ws,'.cache/source/units.json')));assert.equal(sha256(JSON.stringify(c)),m.catalogHash);assert.equal(c.source.length,1900);
  assert.deepEqual(applyReviewedLabelDeferrals(applyFullSiteReplacement(createFullSitePlan(c,new Set(m.retained.map(r=>r.source))),m.authorizedUnknownReplacement),m),m.plan);
  for(const d of labelDeferralReviews(m)){assert.equal(m.inputs[d.reviewFile],d.reviewHash);const {reviewHash,...review}=d;assert.deepEqual(await readJson(join(ws,d.reviewFile)),review);}
  if(m.authorizedUnknownReplacement){const p=m.authorizedUnknownReplacement;assert.equal(m.inputs[p.approvalFile],p.approvalHash);const {approvalHash,...policy}=p;assert.deepEqual(await readJson(join(ws,p.approvalFile)),policy);assert.equal(m.config.maxAttempts,172);assert.equal(m.historyAttemptLimit,613);assert.equal(ledger.historyAttemptLimit,613);}
  const expected=new Map();
  for(const r of m.retained){assert.equal(sha256(await readFile(join(rootDir,r.journalFile))),r.journalHash);if(r.recoveryFile)assert.equal(sha256(await readFile(join(rootDir,r.recoveryFile))),r.recoveryHash);
    assert.equal(sha256(r.translation),r.translationHash);validateChapterTranslation(r.source,r.translation);expected.set(r.source,r.translation);}
  for(const p of m.plan.prefill){validateLabel(p.source,p.translation);expected.set(p.source,p.translation);}
  for(const a of ledger.attempts){const j=m.plan.jobs[a.ordinal-1],bytes=await readFile(join(ws,a.journalFile)),record=JSON.parse(bytes);assert.equal(record.requestId,a.requestId);
    if(isReviewedFullUnknown(a,m)){verifyReviewedFullUnknown(record,m,a,sha256(bytes));continue;}
    if(isReviewedPartialLabel(a,m)){
      verifyFullRequest(record,m,j,{completed:false});const candidate=recoverReviewedPartialLabels(j,record,labelDeferralReviewFor(m,record.requestId),sha256(bytes),validateLabel),e=await readJson(join(ws,a.recoveryFile));
      assert.equal(e.originalJournalHash,sha256(bytes));assert.equal(e.requestId,a.requestId);assert.equal(e.kind,candidate.kind);assert.deepEqual(e.sourceIndices,candidate.sourceIndices);assert.deepEqual(e.translations,candidate.translations);assert.equal(e.addedPaidRequests,0);
      candidate.sourceIndices.forEach((index,i)=>{const source=j.texts[index];assert.ok(!expected.has(source));expected.set(source,candidate.translations[i]);});continue;
    }
    let translations;
    if(a.recoveryFile){verifyFullRequest(record,m,j,{completed:false});assert.equal(j.kind,'body');const e=await readJson(join(ws,a.recoveryFile));assert.equal(e.originalJournalHash,sha256(bytes));assert.equal(e.requestId,record.requestId);assert.equal(e.sourceHash,sha256(j.texts[0]));
      let candidate=recovery.recoverChapterFormat(j.texts[0],record.responseText);
      if(!candidate){const reviewed=m.reviewedFormatCorrections.find(p=>p.requestId===record.requestId);assert.ok(reviewed);const pb=await readFile(join(ws,reviewed.file)),proof=JSON.parse(pb);assert.equal(sha256(pb),reviewed.sha256);
        assert.equal(proof.originalJournalHash,sha256(bytes));assert.equal(proof.originalResponseHash,sha256(record.responseText));assert.equal(proof.requestId,record.requestId);assert.equal(proof.sourceHash,sha256(j.texts[0]));
        for(const fn of ['recoverReviewedDuplicateBold','recoverReviewedMissingBold','recoverReviewedMissingBoldPair','recoverReviewedMissingBoldOpen','recoverReviewedMissingNestedBold','recoverReviewedParagraphBoundaries'])candidate??=recovery[fn](c.units.find(u=>u.id===j.unitId),record.responseText,proof);
        candidate??=recoverReviewedLinkedTitleBold(c.units.find(u=>u.id===j.unitId),record.responseText,proof);
        assert.equal(sha256(candidate.translation),proof.expectedCandidateHash);
      }
      assert.equal(candidate.translation,e.translation);assert.equal(candidate.kind,e.kind);assert.equal(candidate.addedPaidRequests,0);translations=[e.translation];
    }else{verifyFullRequest(record,m,j);translations=record.translations;}
    j.texts.forEach((s,i)=>{assert.ok(!expected.has(s));expected.set(s,translations[i]);});
  }
  assert.equal(expected.size,1900);
  const old=m.parentAudit.oldUnknown;assert.equal(sha256(await readFile(join(rootDir,old.journalFile))),old.journalHash);assert.equal((await readJson(join(rootDir,old.journalFile))).rawUsage,null);
  const formal=await readJson(join(directory,'build-verification.json')),browser=await readJson(join(directory,'browser-verification.json')),navigation=await readJson(join(directory,'preview-navigation-verification.json'));
  assert.ok(formal.passed&&formal.formalBuild&&!formal.partial&&formal.totalCompleted===1900);
  assert.ok(browser.passed&&browser.fullSourceCoverage&&browser.formalCompleteLabelVisible&&browser.totalCompleted===1900);
  assert.equal(browser.genreLanguageChecks,1608);assert.equal(browser.staticChecks.reduce((n,x)=>n+x.mappings,0),1824);assert.equal(browser.labelChecks.length,6);
  assert.equal(browser.captionChecks.length,6);
  for(const check of browser.captionChecks){assert.equal(check.captions,2);assert.ok(check.exactText&&check.originalSvgAndLabelIdentity&&check.attributesAndPositionPreserved);if(check.language==='en')assert.equal(check.originalEnglishNodesRestored,true);}
  assert.deepEqual(browser.errors,[]);assert.equal(browser.deepseekBrowserRequests,0);assert.ok(navigation.passed&&navigation.translatedAnchorNativeHandlerVerified);
  assert.equal(sha256(await readFile(join(rootDir,'test/full-site-browser.mjs'))),browser.browserScriptHash);
  const files=await treeHashes(join(ws,'dist'));assert.deepEqual(files,browser.buildFileHashes,'Build changed after exhaustive browser acceptance.');
  const extra=['_zh/overlay.js','_zh/overlay.css','_zh/dictionary.js','_zh/chapter-renderer.js','_zh/chapter-caption-renderer.js','_zh/units.json','_zh/locales/zh-Hans.json','_zh/locales/zh-Hant.json','_zh/translation-status.json'];
  const allowed=[...Object.keys(m.inputs).filter(f=>f.startsWith('generated/site/')).map(f=>f.slice('generated/site/'.length)),...extra].sort();assert.deepEqual(Object.keys(files).sort(),allowed,'Unlisted data must never enter a website package.');
  const locales={};for(const language of ['zh-Hans','zh-Hant']){const locale=await readJson(join(ws,`generated/locales/${language}.json`));assert.equal(Object.keys(locale).length,1900);
    for(const s of c.source){if(isChapterSource(s))validateChapterTranslation(s,locale[s]);else validateLabel(s,locale[s]);if(language==='zh-Hans')assert.equal(locale[s],expected.get(s));}locales[language]=locale;}
  const conversion=await readJson(join(ws,'generated/conversion-status.json'));assert.ok(conversion.complete);assert.equal(conversion.sourceHash,c.sourceHash);assert.equal(conversion.simplifiedHash,hashLocale(locales['zh-Hans']));assert.equal(conversion.traditionalHash,hashLocale(locales['zh-Hant']));assert.equal(conversion.terminologyHash,TERMINOLOGY_HASH);assert.deepEqual(conversion.converter,CONVERTER);
  const status=await readJson(join(ws,'dist/_zh/translation-status.json'));for(const lang of ['zh-Hans','zh-Hant'])assert.deepEqual(status.languages[lang],{translated:1900,total:1900,complete:true});
  const buffers=new Map();for(const file of allowed){const bytes=await readFile(join(ws,'dist',file));let expectedBytes;
    if(file==='index.html')expectedBytes=Buffer.from(prepareHTML(await readFile(join(ws,'generated/site/index.html'),'utf8'),status));
    else if(file==='main.bundle.js')expectedBytes=Buffer.from(prepareBundle(await readFile(join(ws,'generated/site/main.bundle.js'),'utf8')));
    else if(file.startsWith('_zh/locales/'))expectedBytes=Buffer.from(JSON.stringify(locales[basename(file,'.json')]));
    else if(file==='_zh/units.json')expectedBytes=Buffer.from(JSON.stringify(c));
    else if(file==='_zh/translation-status.json')expectedBytes=bytes;
    else expectedBytes=await readFile(join(ws,file.startsWith('_zh/')?`public/${basename(file)}`:`generated/site/${file}`));
    assert.ok(bytes.equals(expectedBytes),file);buffers.set(`dist/${file}`,bytes);
  }
  buffers.set('server.mjs',await readFile(join(ws,'server.mjs')));
  return {rootDir,buffers,total:1900,bodyTotal:562,labelTotal:1338,sourceHash:c.sourceHash,sourceFingerprint:c.snapshotHash,sourceUrl:'https://musicmap.info/',
    model:'deepseek-v4-pro',reasoningEffort:'max',thinking:'enabled',maxTokens:32768,
    productionCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:rootDir,encoding:'utf8'}).trim(),buildDate:formal.builtAt,
    verifiedAt:browser.verifiedAt,productionFinishedAt:browser.verifiedAt,conversion:{sourceHash:conversion.sourceHash,simplifiedHash:conversion.simplifiedHash,traditionalHash:conversion.traditionalHash,terminologyHash:conversion.terminologyHash,converter:conversion.converter}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args.some(a=>a!=='--check'))throw new Error('Usage: node scripts/package-full-site.mjs [--check]');
  if(args.includes('--check')){const v=await verifyFullSiteRelease();console.log(JSON.stringify({passed:true,total:v.total,body:v.bodyTotal,labels:v.labelTotal,sourceHash:v.sourceHash}));}
  else console.log(JSON.stringify(await packageRelease({fullRun:FULL_RUN,output:'artifacts/musicmap-zh-complete-2026-10-15.tar.gz'}),null,2));
 }catch(e){console.error(`Full-site package stopped: ${e.message}`);process.exitCode=1;}
}
