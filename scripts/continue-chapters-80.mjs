#!/usr/bin/env node
import { prepareChapterContinuation, executeChapterContinuation, readChapterContinuationStatus, buildChapterContinuation, recoverChapterContinuation } from '../lib/chapter-continuation-80.mjs';
const actions = { '--prepare': prepareChapterContinuation, '--execute': executeChapterContinuation,
  '--status': readChapterContinuationStatus, '--build': buildChapterContinuation, '--recover': recoverChapterContinuation };
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !actions[args[0]])) throw new Error('Usage: node scripts/continue-chapters-80.mjs [--prepare | --execute | --status | --build | --recover]');
  console.log(JSON.stringify(await actions[args[0] ?? '--status'](), null, 2));
} catch (error) {
  console.error(`Continuation stopped (${error.code ?? 'LOCAL_ERROR'}): ${error.message}`); process.exitCode = 1;
}
