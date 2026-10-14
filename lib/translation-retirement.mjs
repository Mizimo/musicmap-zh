import { access } from 'node:fs/promises';
import { join } from 'node:path';

/** A retired corpus or a capped pilot must never enter an uncapped legacy worker. */
export async function assertLegacyTranslationAllowed(rootDir) {
  for (const file of ['retired.json', 'chapter-pilot-policy.json']) {
    try { await access(join(rootDir, 'generated/production', file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const error = new Error('Fragment production is retired. Use production --chapter-pilot; its shared ten-attempt budget cannot be bypassed by legacy workers.');
    error.code = 'TRANSLATION_RETIRED';
    throw error;
  }
}
