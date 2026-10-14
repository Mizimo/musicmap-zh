// Explicit local evidence audit. No API, production writes, or synthetic fallback.
import { access } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFullSiteParent,PARENT_RUN } from '../lib/full-site-parent.mjs';
const root=resolve(process.argv[2]??fileURLToPath(new URL('..',import.meta.url)));
try {
  await access(join(root,PARENT_RUN,'manifest.json'));
  const result=await auditFullSiteParent(root);
  console.log(JSON.stringify({kind:'private-historical-evidence-integration',...result.audit},null,2));
}catch(error){
  console.error(error.code==='ENOENT'
    ?'Private historical evidence is required for this explicit integration check. No source, journal or key is fetched; this check has not passed.'
    :`Private historical evidence verification failed: ${error.message}`);
  process.exitCode=error.code==='ENOENT'?2:1;
}
