import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extract as extractTar, list as listTar } from 'tar';
import { build } from '../scripts/build.mjs';
import { convertToTraditional } from '../lib/chinese-conversion.mjs';
import { packageRelease, verifyRelease } from '../scripts/package-release.mjs';
import { FROZEN_FILES, prepareProduction } from '../scripts/production.mjs';
import { syncSource } from '../scripts/sync-source.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function save(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
const json = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-release-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const path of FROZEN_FILES) await save(rootDir, path, `fixture ${path}`);
  await cp(join(projectRoot, 'data/terminology.json'), join(rootDir, 'data/terminology.json'));
  await cp(join(projectRoot, 'server.mjs'), join(rootDir, 'server.mjs'));
  for (const file of ['overlay.js', 'overlay.css', 'dictionary.js']) {
    await cp(join(projectRoot, 'public', file), join(rootDir, 'public', file));
  }
  const payloads = {
    '/': '<html><head><title>Musicmap</title></head><body><p>Search</p><footer>Musicmap original attribution</footer></body></html>',
    '/main.bundle.js': `var Bn;window.onYouTubeIframeAPIReady=function(){Bn=new YT.Player("one",{})};window.start=function(){Bn=new YT.Player("two",{})};function play(){var states=[${Array(10).fill('Bn.getPlayerState()').join(',')}];Bn.playVideoAt(0);Bn.cuePlaylist({});Bn.cuePlaylist({})}`,
    '/main.css': 'body{color:black}',
    '/master-genrelist.json': JSON.stringify({ jaz: { name: 'JAZZ', description: 'A musical style.' } }),
  };
  await syncSource({ root: rootDir, force: true, fetchImpl: async (url) => new Response(payloads[new URL(url).pathname]) });
  const strings = await json(rootDir, '.cache/source/strings.json');
  await save(rootDir, 'generated/locales/zh-Hans.json', Object.fromEntries(strings.map((text) => [text, `简体译文：${text}`])));
  await convertToTraditional({ rootDir, log: () => {} });
  await build({ projectRoot: rootDir });
  const prepared = await prepareProduction({ rootDir, authSourceFile: join(rootDir, 'key-never-read') });
  const finishedAt = new Date(Date.now() + 10).toISOString();
  await save(rootDir, 'generated/production/status.json', {
    ...prepared, state: 'completed', finishedAt,
    finalization: ['merge', 'convert', 'build', 'test:browser'].map((script) => ({ script, exitCode: 0, finishedAt })),
  });
  return { rootDir, total: strings.length };
}

test('complete package contains only deployment files, verified checksums, and a working dependency-free local server', async (t) => {
  const { rootDir, total } = await fixture(t);
  const privateText = 'PRIVATE-FIXTURE-DO-NOT-PACKAGE';
  for (const path of ['.env', '.cache/translations/entry.json', 'generated/translation-requests/zh-Hans-1-of-8/request.json', 'auth.json']) {
    await save(rootDir, path, privateText);
  }
  const result = await packageRelease({ rootDir, date: new Date('2026-10-13T13:00:00Z') });
  assert.equal(result.complete, true);
  assert.equal(result.total, total);
  assert.equal(hash(await readFile(result.output)), result.sha256);
  assert.equal(await readFile(result.checksumFile, 'utf8'), `${result.sha256}  musicmap-zh-complete-2026-10-13.tar.gz\n`);
  const entries = [];
  await listTar({ file: result.output, onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
  assert.equal(entries.length, result.files);
  assert.ok(entries.every((entry) => entry.type === 'File' && entry.path.startsWith('musicmap-zh/')));
  assert.ok(entries.every((entry) => !/\.env|\.cache|auth\.json|translation-requests|generated\//.test(entry.path)));
  const target = join(rootDir, 'extracted');
  await mkdir(target);
  await extractTar({ file: result.output, cwd: target });
  const packageRoot = join(target, 'musicmap-zh');
  const checksumLines = (await readFile(join(packageRoot, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  assert.equal(checksumLines.length, entries.length - 1);
  for (const line of checksumLines) {
    const [, expected, path] = line.match(/^([a-f0-9]{64})  (.+)$/);
    const data = await readFile(join(packageRoot, path));
    assert.equal(hash(data), expected);
    assert.equal(data.includes(privateText), false);
  }
  const release = await json(packageRoot, 'RELEASE-MANIFEST.json');
  assert.equal(release.translation.total, total);
  assert.equal(release.translation.complete, true);
  assert.equal(release.verification.strictBuild, true);
  assert.equal(release.authSourceFile, undefined);
  assert.equal(JSON.stringify(release).includes(rootDir), false);
  assert.match(await readFile(join(packageRoot, 'README.md'), 'utf8'), /python3 -m http\.server/);
  assert.match(await readFile(join(packageRoot, 'dist/index.html'), 'utf8'), /Musicmap original attribution/);

  const { createApp } = await import(pathToFileURL(join(packageRoot, 'server.mjs')).href);
  const server = createApp({ directory: join(packageRoot, 'dist') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 200);
  for (const language of ['zh-Hans', 'zh-Hant']) {
    const response = await fetch(`${url}/_zh/locales/${language}.json`);
    assert.equal(response.status, 200);
    assert.equal(Object.keys(await response.json()).length, total);
  }
  assert.equal((await fetch(`${url}/api/translate`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/.env`)).status, 403);
  await assert.rejects(packageRelease({ rootDir, date: new Date('2026-10-13T13:00:00Z') }), { code: 'OUTPUT_EXISTS' });
});

test('a completed flag cannot hide missing translations or stale conversion hashes', async (t) => {
  const { rootDir } = await fixture(t);
  const hans = await json(rootDir, 'generated/locales/zh-Hans.json');
  const partial = { ...hans };
  delete partial[Object.keys(partial)[0]];
  await save(rootDir, 'generated/locales/zh-Hans.json', partial);
  await assert.rejects(packageRelease({ rootDir }), { code: 'INCOMPLETE_LOCALE' });
  await save(rootDir, 'generated/locales/zh-Hans.json', hans);
  const conversion = await json(rootDir, 'generated/conversion-status.json');
  await save(rootDir, 'generated/conversion-status.json', { ...conversion, simplifiedHash: 'outdated' });
  await assert.rejects(packageRelease({ rootDir }), { code: 'STALE_CONVERSION' });
  await assert.rejects(readFile(join(rootDir, 'artifacts')), { code: 'ENOENT' });
});

test('release requires production completion and all successful verification steps', async (t) => {
  const { rootDir } = await fixture(t);
  const production = await json(rootDir, 'generated/production/status.json');
  await save(rootDir, 'generated/production/status.json', { ...production, state: 'failed' });
  await assert.rejects(verifyRelease({ rootDir }), { code: 'PRODUCTION_INCOMPLETE' });
  await save(rootDir, 'generated/production/status.json', {
    ...production, finalization: production.finalization.map((step) => step.script === 'test:browser' ? { ...step, exitCode: 1 } : step),
  });
  await assert.rejects(verifyRelease({ rootDir }), { code: 'VERIFICATION_INCOMPLETE' });
  await save(rootDir, 'generated/production/status.json', { ...production, translated: production.total - 1 });
  await assert.rejects(verifyRelease({ rootDir }), { code: 'SOURCE_MISMATCH' });
});

test('complete metadata cannot disguise modified dist translations, source assets, or post-verification changes', async (t) => {
  const { rootDir } = await fixture(t);
  const localePath = 'dist/_zh/locales/zh-Hans.json';
  const original = await readFile(join(rootDir, localePath), 'utf8');
  await save(rootDir, localePath, { changed: '不匹配的譯文' });
  await assert.rejects(verifyRelease({ rootDir }), { code: 'STALE_BUILD' });
  await save(rootDir, localePath, original);
  const production = await json(rootDir, 'generated/production/status.json');
  const verified = new Date(production.finalization.at(-1).finishedAt);
  await utimes(join(rootDir, localePath), verified, verified);
  const future = new Date(verified.getTime() + 60_000);
  await utimes(join(rootDir, 'dist/main.css'), future, future);
  await assert.rejects(verifyRelease({ rootDir }), { code: 'STALE_VERIFICATION' });
});

test('private extra files and symbolic links in dist are rejected before an archive is written', async (t) => {
  const { rootDir } = await fixture(t);
  await save(rootDir, 'dist/private-credentials.txt', 'PRIVATE-FIXTURE');
  await assert.rejects(packageRelease({ rootDir }), { code: 'UNLISTED_BUILD_FILE' });
  await rm(join(rootDir, 'dist/private-credentials.txt'));
  await save(rootDir, '.env', 'PRIVATE-FIXTURE');
  await rm(join(rootDir, 'dist/main.css'));
  await symlink(join(rootDir, '.env'), join(rootDir, 'dist/main.css'));
  await assert.rejects(packageRelease({ rootDir }), { code: 'UNSAFE_FILE' });
});

test('active production locks, changed frozen files, and unsafe output destinations prevent packaging', async (t) => {
  const { rootDir } = await fixture(t);
  await mkdir(join(rootDir, 'generated/production/lock'));
  await assert.rejects(verifyRelease({ rootDir }), { code: 'PRODUCTION_ACTIVE' });
  await rm(join(rootDir, 'generated/production/lock'), { recursive: true });
  await save(rootDir, 'lib/translator.mjs', 'changed production code');
  await assert.rejects(verifyRelease({ rootDir }), { code: 'FROZEN_INPUT_CHANGED' });
  await assert.rejects(packageRelease({ rootDir, output: 'dist/release.tar.gz' }), { code: 'INVALID_OUTPUT' });
  await assert.rejects(packageRelease({ rootDir, output: '../outside.tar.gz' }), { code: 'INVALID_OUTPUT' });
});
