import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('full-site package CLI finishes module evaluation before its writer reimports the verifier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-package-cli-'));
  const cliURL = new URL('../scripts/package-full-site.mjs', import.meta.url).href;
  const writerURL = new URL('../scripts/package-release.mjs', import.meta.url).href;
  // Replace only the writer boundary. Its real fullRun branch dynamically
  // imports this same CLI to get verifyFullSiteRelease; no private data or API.
  const writer = `export async function packageRelease() {
    const module = await import(${JSON.stringify(cliURL)});
    return { selfImportResolved: typeof module.verifyFullSiteRelease === 'function' };
  }`;
  const loader = `export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    if (context.parentURL === ${JSON.stringify(cliURL)} && result.url === ${JSON.stringify(writerURL)})
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(writer))}, shortCircuit: true };
    return result;
  }`;
  try {
    const loaderFile = join(directory, 'writer-boundary-loader.mjs');
    await writeFile(loaderFile, loader);
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--experimental-loader', loaderFile, fileURLToPath(cliURL)], { timeout: 15000 });
    assert.deepEqual(JSON.parse(stdout), { selfImportResolved: true });
    assert.doesNotMatch(stderr, /unsettled top-level await/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
