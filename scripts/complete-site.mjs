#!/usr/bin/env node
import {prepareFullSite,executeFullSite,readFullSiteStatus,recoverFullSite,buildFullSite} from '../lib/full-site.mjs';
const actions={'--prepare':prepareFullSite,'--execute':executeFullSite,'--status':readFullSiteStatus,'--recover':recoverFullSite,'--build':buildFullSite};
try{const args=process.argv.slice(2);if(args.length>1||(args.length&&!actions[args[0]]))throw new Error('Usage: node scripts/complete-site.mjs [--prepare|--execute|--status|--recover|--build]');
  console.log(JSON.stringify(await actions[args[0]??'--status'](),null,2));
}catch(e){console.error(`Full-site stopped (${e.code??'LOCAL_ERROR'}): ${e.message}`);process.exitCode=1;}
