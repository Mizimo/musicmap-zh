import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const profiles=Object.freeze({
 'cb6b9b93-25e7-4d68-a780-261cbaf8125b':{ordinal:120,jobId:'labels-119',indices:[...Array.from({length:18},(_,i)=>i),19],missing:[18],tailId:'labels-171',tailCount:14,priorDeferred:0},
 '841feac0-2380-4735-a0c8-edab6e4c2346':{ordinal:148,jobId:'labels-147',indices:[...Array.from({length:14},(_,i)=>i),15,16,17,18,19],missing:[14],tailId:'labels-171-reviewed-deferral',tailCount:19,priorDeferred:5},
 '55b33de9-fdfc-4cf0-8424-66fb6a8850e4':{ordinal:133,jobId:'labels-132',indices:[...Array.from({length:14},(_,i)=>i),18,19],missing:[14,15,16,17],tailId:'labels-171-reviewed-deferral',tailCount:15,priorDeferred:1},
});
const fail=()=>{throw Object.assign(new Error('Only individually reviewed request120/133/148 omissions may move into the unsent final label batch.'),{code:'LABEL_DEFERRAL_INVALID'});};
const profile=review=>{const p=profiles[review?.requestId];if(!p)fail();return p;};
export const labelDeferralReviews=manifest=>[manifest.reviewedLabelDeferral,manifest.reviewedAdditionalLabelDeferral,manifest.reviewedThirdLabelDeferral].filter(Boolean);
export const labelDeferralReviewFor=(manifest,requestId)=>labelDeferralReviews(manifest).find(r=>r.requestId===requestId);
export function applyReviewedLabelDeferrals(plan,manifest){for(const review of labelDeferralReviews(manifest))plan=applyReviewedLabelDeferral(plan,review);return plan;}

export function applyReviewedLabelDeferral(plan,review){
 if(!review)return plan;
 const p=profile(review),job=plan.jobs[p.ordinal-1],tail=plan.jobs.at(-1),missing=review.missingSourceIndices??[review.missingSourceIndex],hashes=review.missingSourceHashes??[review.missingSourceHash];
 if(review.type!=='reviewed-label-omission-deferral'||review.approval!=='approved-coordinator-technical-amendment'
  ||review.ordinal!==p.ordinal||review.originalJobId!==job?.jobId||job?.jobId!==p.jobId
  ||job.kind!=='labels'||job.texts.length!==20||review.originalRequestSourceHash!==job.sourceHash
  ||!same(review.sourceIndexForEachOutput,p.indices)||review.verbatimOutputHashes?.length!==p.indices.length
  ||!review.verbatimOutputHashes.every(h=>/^[a-f0-9]{64}$/.test(h))
  ||!same(missing,p.missing)||!same(hashes,p.missing.map(i=>job.sourceHashes[i]))
  ||tail?.jobId!==p.tailId||tail.kind!=='labels'||tail.texts.length!==p.tailCount
  ||(plan.counts.reviewedDeferredLabels??0)!==p.priorDeferred
  ||review.tailOriginalJobId!==tail.jobId||review.tailOriginalSourceHash!==tail.sourceHash
  ||plan.jobs.length!==172||plan.counts.maxAttempts!==172||review.cap!==172||review.historyCap!==613
  ||review.additionalRequestReservations!==0
  ||![review.originalJournalHash,review.originalResponseHash,review.reviewHash].every(h=>/^[a-f0-9]{64}$/.test(h??''))
  ||!/^data\/[\w./-]+\.json$/.test(review.reviewFile??'')||review.reviewFile.includes('..'))fail();
 const texts=[...tail.texts,...p.missing.map(i=>job.texts[i])],contexts=[...tail.contexts,...p.missing.map(i=>job.contexts[i])];
 if(texts.length>20||texts.reduce((n,s)=>n+s.length,0)>14000||new Set(texts).size!==texts.length)fail();
 const deferred=(plan.counts.reviewedDeferredLabels??0)+p.missing.length;
 const replacement={...tail,jobId:'labels-171-reviewed-deferral',texts,contexts,sourceHashes:texts.map(sha),sourceHash:sha(JSON.stringify(texts)),
  deferredFromRequestId:tail.deferredFromRequestId??review.requestId,deferredSourceIndex:tail.deferredSourceIndex??p.missing[0],originalJobSourceHash:tail.originalJobSourceHash??tail.sourceHash,
  reviewedDeferredSources:[...(tail.reviewedDeferredSources??[]),{requestId:review.requestId,sourceIndices:[...p.missing],sourceHashes:p.missing.map(i=>job.sourceHashes[i])}]};
 return {...plan,jobs:[...plan.jobs.slice(0,-1),replacement],counts:{...plan.counts,reviewedDeferredLabels:deferred,paidLabelInputItems:plan.counts.pendingLabels+deferred}};
}

export function isReviewedPartialLabel(attempt,manifest){
 const review=labelDeferralReviewFor(manifest,attempt.requestId);if(!review)return false;const p=profile(review);
 return attempt.ordinal===p.ordinal&&attempt.jobId===p.jobId&&attempt.sourceHash===review.originalRequestSourceHash&&attempt.state==='recovered-partial'
  &&same(attempt.recoveredSourceIndices,review.sourceIndexForEachOutput);
}

export function recoverReviewedPartialLabels(job,record,review,journalHash,validateLabel){
 const p=profile(review);
 if(record.requestId!==review.requestId||record.type!=='failed'||record.errorCode!=='INVALID_TRANSLATION'
  ||job.jobId!==p.jobId||job.kind!=='labels'||job.texts.length!==20||record.sourceCount!==20
  ||record.sourceHash!==job.sourceHash||job.sourceHash!==review.originalRequestSourceHash
  ||journalHash!==review.originalJournalHash||sha(record.responseText)!==review.originalResponseHash
  ||!same(review.sourceIndexForEachOutput,p.indices)||typeof validateLabel!=='function')fail();
 const payload=JSON.parse(record.responseText);
 if(Object.keys(payload).length!==1||!Array.isArray(payload.translations)||payload.translations.length!==p.indices.length
  ||!same(payload.translations.map(sha),review.verbatimOutputHashes))fail();
 const translations=payload.translations;translations.forEach((text,i)=>validateLabel(job.texts[p.indices[i]],text));
 return {kind:'reviewed-partial-label-output',sourceIndices:[...p.indices],translations,missingSourceIndices:[...p.missing],originalSourceCount:20,
  recoveredSourceCount:p.indices.length,translatedTextChanged:false,outputOrderChanged:false,addedPaidRequests:0};
}
