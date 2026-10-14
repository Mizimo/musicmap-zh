import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateUnitCatalog, validateChapterTranslation } from './chapter-units.mjs';
import * as recovery from './chapter-format-recovery-80.mjs';
import { CHAPTER_PROMPT_TEMPLATE_HASH } from './translator.mjs';
import { TERMINOLOGY_HASH, SIMPLIFIED_TERMINOLOGY_HASH } from './terminology.mjs';

export const PARENT_RUN = 'artifacts/chapter-continuation/2026-10-14-body-80pct';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export async function treeHashes(root, prefix = '') {
  const files = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await treeHashes(root, name));
    else { assert.ok(entry.isFile(), `Unexpected non-file: ${name}`); files[name] = sha256(await readFile(join(root, name))); }
  }
  return files;
}
export function knownUsage(record) {
  const u=record?.rawUsage;
  const valid=n=>Number.isSafeInteger(n)&&n>=0, optional=n=>n==null||valid(n);
  return !!u&&valid(u.prompt_tokens)&&valid(u.completion_tokens)&&optional(u.total_tokens)
    &&(u.total_tokens==null||u.total_tokens===u.prompt_tokens+u.completion_tokens)
    &&optional(u.completion_tokens_details?.reasoning_tokens)
    &&(u.completion_tokens_details?.reasoning_tokens==null||u.completion_tokens_details.reasoning_tokens<=u.completion_tokens)
    &&optional(u.prompt_cache_hit_tokens)&&optional(u.prompt_cache_miss_tokens)
    &&(u.prompt_cache_hit_tokens==null||u.prompt_cache_hit_tokens<=u.prompt_tokens)
    &&(u.prompt_cache_miss_tokens==null||u.prompt_cache_miss_tokens<=u.prompt_tokens)
    &&(u.prompt_cache_hit_tokens==null||u.prompt_cache_miss_tokens==null||u.prompt_cache_hit_tokens+u.prompt_cache_miss_tokens===u.prompt_tokens);
}
export async function auditFullSiteParent(root) {
  const run=join(root,PARENT_RUN), ws=join(run,'workspace'), m=await readJson(join(run,'manifest.json'));
  const ledgerBytes=await readFile(join(root,'generated/production/chapter-continuation-80pct.json'));
  const ledger=JSON.parse(ledgerBytes);
  assert.equal(ledger.manifestHash,sha256(await readFile(join(run,'manifest.json'))));
  assert.equal(ledger.state,'target-reached');assert.equal(ledger.attempts.length,224);
  assert.deepEqual(ledger,await readJson(join(run,'quota-ledger.json')));
  let frozen=0;
  // The versioned parent workspace is the original program. New root code may
  // evolve without changing a single byte of this historical program or manifest.
  for(const [base, files] of [[root,m.priorEvidence],[ws,{...m.program,...m.inputs}]])
    for(const [file,digest] of Object.entries(files)){assert.equal(sha256(await readFile(join(base,file))),digest,file);frozen++;}
  assert.equal(m.promptTemplateHash,CHAPTER_PROMPT_TEMPLATE_HASH);assert.equal(m.terminologyHash,TERMINOLOGY_HASH);
  const catalog=validateUnitCatalog(await readJson(join(ws,'.cache/source/units.json')));
  assert.equal(sha256(JSON.stringify(catalog)),m.catalogHash);assert.equal(catalog.sourceHash,m.sourceHash);
  const retained=[], translations=new Map();let recovered=0;
  const entries=[...m.retained, ...ledger.attempts.map(a=>({...a,
    journalFile:`${PARENT_RUN}/workspace/${a.journalFile}`,
    ...(a.recoveryFile?{recoveryFile:`${PARENT_RUN}/workspace/${a.recoveryFile}`}:{ }),
    identityKind:'continuation',identityId:m.id,
    reviewedCorrection:m.reviewedFormatCorrections?.find(p=>p.requestId===a.requestId)
      ?{...m.reviewedFormatCorrections.find(p=>p.requestId===a.requestId),file:`${PARENT_RUN}/workspace/${m.reviewedFormatCorrections.find(p=>p.requestId===a.requestId).file}`}:undefined}))];
  for(const prior of entries){
    const unit=catalog.units.find(u=>u.id===prior.unitId);assert.ok(unit);
    const bytes=await readFile(join(root,prior.journalFile)),record=JSON.parse(bytes);
    if(prior.journalHash)assert.equal(sha256(bytes),prior.journalHash);
    assert.equal(record.requestId,prior.requestId);assert.equal(prior.sourceHash,sha256(unit.source));
    for(const [key,value] of Object.entries({model:'deepseek-v4-pro',returnedModel:'deepseek-v4-pro',reasoningEffort:'max',maxTokens:32768,timeoutMs:600000,language:'zh-Hans',httpStatus:200,finishReason:'stop',sourceCount:1,promptTemplateHash:CHAPTER_PROMPT_TEMPLATE_HASH,terminologyHash:SIMPLIFIED_TERMINOLOGY_HASH,requestSent:true}))assert.equal(record[key],value,`${prior.unitId}: ${key}`);
    assert.ok(knownUsage(record));assert.equal(record.sourceHash,sha256(JSON.stringify([unit.source])));
    assert.deepEqual(record.textHashes,[sha256(unit.source)]);assert.equal(record.identityHash,sha256(JSON.stringify(record.identity)));
    assert.equal(record.identity[prior.identityKind==='pilot'?'pilot':'continuation'],prior.identityId);
    assert.equal(record.identity.catalogHash,m.catalogHash);assert.equal(record.identity.sourceHash,m.sourceHash);assert.equal(record.identity.terminologyHash,TERMINOLOGY_HASH);
    let translation=record.translations?.[0], proof=null;
    if(prior.recoveryFile){
      assert.equal(record.type,'failed');const rb=await readFile(join(root,prior.recoveryFile)),e=JSON.parse(rb);
      if(prior.recoveryHash)assert.equal(sha256(rb),prior.recoveryHash);
      assert.equal(e.originalJournalHash,sha256(bytes));assert.equal(e.requestId,record.requestId);assert.equal(e.sourceHash,sha256(unit.source));
      let candidate=recovery.recoverChapterFormat(unit.source,record.responseText);
      if(!candidate){
        assert.ok(prior.reviewedCorrection);const pb=await readFile(join(root,prior.reviewedCorrection.file));proof=JSON.parse(pb);
        assert.equal(sha256(pb),prior.reviewedCorrection.sha256);assert.equal(proof.originalJournalHash,sha256(bytes));
        assert.equal(proof.originalResponseHash,sha256(record.responseText));assert.equal(proof.sourceHash,sha256(unit.source));assert.equal(proof.requestId,record.requestId);assert.equal(proof.unitId,unit.id);
        for(const fn of ['recoverReviewedDuplicateBold','recoverReviewedMissingBold','recoverReviewedMissingBoldPair','recoverReviewedMissingBoldOpen','recoverReviewedMissingNestedBold','recoverReviewedParagraphBoundaries'])candidate??=recovery[fn](unit,record.responseText,proof);
        assert.ok(candidate);assert.equal(sha256(candidate.translation),proof.expectedCandidateHash);
      }
      assert.ok(candidate);assert.equal(candidate.translation,e.translation);assert.equal(candidate.kind,e.kind);assert.equal(candidate.addedPaidRequests,0);
      translation=e.translation;recovered++;
    }else assert.equal(record.type,'completed');
    validateChapterTranslation(unit.source,translation);if(prior.translationHash)assert.equal(sha256(translation),prior.translationHash);
    assert.ok(!translations.has(unit.source));translations.set(unit.source,translation);
    retained.push({unitId:unit.id,source:unit.source,sourceHash:sha256(unit.source),translation,translationHash:sha256(translation),requestId:record.requestId,journalFile:prior.journalFile,journalHash:sha256(bytes),
      ...(prior.recoveryFile?{recoveryFile:prior.recoveryFile,recoveryHash:sha256(await readFile(join(root,prior.recoveryFile))),recoveryKind:(await readJson(join(root,prior.recoveryFile))).kind}:{}),
      ...(proof?{reviewedCorrection:prior.reviewedCorrection}:{})});
  }
  assert.equal(translations.size,450);assert.equal(recovered,25);
  const actual=new Map();for(let i=1;i<=8;i++){const s=await readJson(join(ws,`generated/shards/zh-Hans-${i}-of-8.json`));for(const [source,t]of Object.entries(s.translations)){assert.ok(!actual.has(source));actual.set(source,t);}}
  assert.deepEqual(actual,translations);
  const ub=await readFile(join(root,m.supersedesUnknown.journalFile)),unknown=JSON.parse(ub);
  assert.equal(sha256(ub),m.supersedesUnknown.journalHash);assert.equal(unknown.type,'failed');assert.equal(unknown.rawUsage,null);
  return {manifest:m,ledger,catalog,workspace:ws,retained,translations,
    audit:{passed:true,retainedBody:450,recovered:25,frozenFilesVerified:frozen,parentLedgerHash:sha256(ledgerBytes),oldUnknown:m.supersedesUnknown}};
}
