import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { create as createTar } from 'tar';
import { syncSource } from '../scripts/sync-source.mjs';
import { exportSnapshot, importSnapshot, verifySnapshot } from '../scripts/snapshot.mjs';

async function fixture(root, label = 'Original source') {
  const payloads = {
    '/': `<html><body><p>${label}</p></body></html>`,
    '/main.bundle.js': 'void 0;',
    '/main.css': 'body{color:white}',
    '/master-genrelist.json': JSON.stringify({ jaz: { name: 'JAZZ', description: 'A musical style.' } }),
  };
  await syncSource({ root, force: true, fetchImpl: async url => new Response(payloads[new URL(url).pathname]) });
}

async function save(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }

test('snapshot roundtrip reproduces identical source and leaves settings, translations, and locales alone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'musicmap-snapshot-roundtrip-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    await fixture(source);
    for (const root of [source, target]) {
      await save(join(root, '.env'), 'PRIVATE_TEST_VALUE=unchanged');
      await save(join(root, '.cache/translations/existing.json'), '{"keep":true}');
      await save(join(root, 'public/locales/zh-Hant.json'), '{"local":"keep"}');
    }
    const output = await exportSnapshot({ root: source });
    const original = await verifySnapshot(source);
    const imported = await importSnapshot({ root: target, archive: output.output });
    assert.equal(imported.fingerprint, original.fingerprint);
    assert.equal(imported.unchanged, false);
    assert.deepEqual(await readFile(join(source, '.cache/source/strings.json')), await readFile(join(target, '.cache/source/strings.json')));
    assert.deepEqual(await readFile(join(source, 'generated/source-manifest.json')), await readFile(join(target, 'generated/source-manifest.json')));
    assert.equal((await importSnapshot({ root: target, archive: output.output })).unchanged, true);
    for (const path of ['.env', '.cache/translations/existing.json', 'public/locales/zh-Hant.json']) {
      assert.equal(await readFile(join(target, path), 'utf8'), await readFile(join(source, path), 'utf8'));
      assert.ok(!imported.files.includes(path));
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('refuses divergent snapshots without force and refuses tampered data even with force', async () => {
  const base = await mkdtemp(join(tmpdir(), 'musicmap-snapshot-integrity-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    await fixture(source, 'Source A');
    await fixture(target, 'Source B');
    await save(join(target, '.cache/translations/existing.json'), 'keep this translation cache');
    const archive = await exportSnapshot({ root: source });
    const before = await verifySnapshot(target);
    await assert.rejects(importSnapshot({ root: target, archive: archive.output }), /differs/);
    assert.equal((await verifySnapshot(target)).fingerprint, before.fingerprint);
    const forced = await importSnapshot({ root: target, archive: archive.output, force: true });
    assert.equal(forced.fingerprint, archive.fingerprint);
    assert.equal(await readFile(join(target, '.cache/translations/existing.json'), 'utf8'), 'keep this translation cache');
    const files = (await verifySnapshot(source)).files;
    await writeFile(join(source, 'generated/site/index.html'), '<p>Tampered bytes.</p>');
    const malicious = join(base, 'tampered.tar.gz');
    await createTar({ cwd: source, file: malicious, gzip: true }, files);
    await assert.rejects(importSnapshot({ root: target, archive: malicious, force: true }), /hash verification failed/);
    assert.equal((await verifySnapshot(target)).fingerprint, archive.fingerprint);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('rejects traversal, links, duplicate entries, settings files, and destination symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'musicmap-snapshot-safety-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    await fixture(source);
    await mkdir(target);
    const exported = await exportSnapshot({ root: source });
    const cases = [
      { name: 'traversal', paths: ['generated/site/index.html'], options: { prefix: '../escaped', preservePaths: true }, pattern: /unsafe path/ },
      { name: 'settings', paths: ['.env'], options: {}, pattern: /allowlist/ },
      { name: 'duplicate', paths: ['generated/site/index.html', 'generated/site/index.html'], options: {}, pattern: /duplicate/ },
      { name: 'symlink', paths: ['generated/site/link.js'], options: {}, pattern: /links/ },
    ];
    await save(join(source, '.env'), 'not for export');
    await symlink(join(source, '.env'), join(source, 'generated/site/link.js'));
    for (const item of cases) {
      const archive = join(base, `${item.name}.tar.gz`);
      await createTar({ cwd: source, file: archive, gzip: true, ...item.options }, item.paths);
      await assert.rejects(importSnapshot({ root: target, archive, force: true }), item.pattern);
    }
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(target, 'generated'));
    await assert.rejects(importSnapshot({ root: target, archive: exported.output, force: true }), /symbolic links/);
    await assert.rejects(readFile(join(outside, 'source-manifest.json')), { code: 'ENOENT' });
  } finally { await rm(base, { recursive: true, force: true }); }
});
