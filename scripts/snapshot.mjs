import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create as createTar, Parser } from 'tar';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'generated/source-manifest.json';
const STRINGS = '.cache/source/strings.json';
const SITE = 'generated/site';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function safeRelativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0:]/.test(path)) throw new Error('Snapshot contains an unsafe path.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Snapshot contains an unsafe path.');
  return path;
}

function allowedFile(path) {
  safeRelativePath(path);
  return path === MANIFEST || path === STRINGS || (path.startsWith(`${SITE}/`) && !path.slice(SITE.length + 1).split('/').some(part => part.startsWith('.')));
}

function parseManifest(buffer) {
  let manifest;
  try { manifest = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('Source manifest is not valid JSON.'); }
  if (manifest?.version !== 1 || manifest.sourceUrl !== 'https://musicmap.info/' || manifest.siteDirectory !== SITE || manifest.stringsPath !== STRINGS || !validHash(manifest.stringsSha256)) {
    throw new Error('Source manifest has an unsupported format.');
  }
  if (!Array.isArray(manifest.resources) || !manifest.resources.length || manifest.resources.length > MAX_ENTRIES - 2 || manifest.resourceCount !== manifest.resources.length) {
    throw new Error('Source manifest resource count is invalid.');
  }
  const paths = new Set();
  for (const resource of manifest.resources) {
    const path = safeRelativePath(resource.path);
    if (!allowedFile(`${SITE}/${path}`) || paths.has(path) || !validHash(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes <= 0 || resource.bytes > MAX_FILE_BYTES) {
      throw new Error('Source manifest has an invalid or duplicate resource.');
    }
    paths.add(path);
  }
  for (const path of ['index.html', 'main.bundle.js', 'main.css', 'master-genrelist.json']) {
    if (!paths.has(path)) throw new Error(`Source manifest is missing a required resource: ${path}`);
  }
  return manifest;
}

function validateBuffers(buffers) {
  if (!buffers.has(MANIFEST) || !buffers.has(STRINGS)) throw new Error('Snapshot is missing the source manifest or translation strings.');
  const manifest = parseManifest(buffers.get(MANIFEST));
  const expected = new Set([MANIFEST, STRINGS, ...manifest.resources.map(resource => `${SITE}/${resource.path}`)]);
  if (buffers.size !== expected.size || [...buffers.keys()].some(path => !expected.has(path))) throw new Error('Snapshot contains missing or unlisted files.');
  for (const resource of manifest.resources) {
    const data = buffers.get(`${SITE}/${resource.path}`);
    if (!data || data.length !== resource.bytes || sha256(data) !== resource.sha256) throw new Error(`Source hash verification failed: ${resource.path}`);
  }
  const stringsBuffer = buffers.get(STRINGS);
  if (sha256(stringsBuffer) !== manifest.stringsSha256) throw new Error('Translation strings hash verification failed.');
  let strings;
  try { strings = JSON.parse(stringsBuffer.toString('utf8')); } catch { throw new Error('Translation strings are not valid JSON.'); }
  if (!Array.isArray(strings) || strings.length !== manifest.stringCount || strings.some(text => typeof text !== 'string' || text.length > 5000) || new Set(strings).size !== strings.length) {
    throw new Error('Translation strings do not match the source manifest.');
  }
  const characterCount = strings.reduce((total, text) => total + text.length, 0);
  const longestString = Math.max(0, ...strings.map(text => text.length));
  if (manifest.characterCount !== characterCount || manifest.longestString !== longestString) throw new Error('Translation string counts do not match the source manifest.');
  let genres;
  try { genres = JSON.parse(buffers.get(`${SITE}/master-genrelist.json`).toString('utf8')); } catch { throw new Error('Genre data is not valid JSON.'); }
  if (!genres || typeof genres !== 'object' || Array.isArray(genres) || Object.keys(genres).length !== manifest.genreCount) throw new Error('Genre count does not match the source manifest.');
  const identity = {
    stringsSha256: manifest.stringsSha256,
    resources: manifest.resources.map(({ path, bytes, sha256: hash }) => [path, bytes, hash]).sort((a, b) => a[0].localeCompare(b[0])),
  };
  return { manifest, files: [...expected].sort(), fingerprint: sha256(JSON.stringify(identity)) };
}

// Refuse to follow links already present in a destination or source tree.
async function checkPath(root, path, { missing = false, directory = false } = {}) {
  const parts = safeRelativePath(path).split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const current = resolve(root, ...parts.slice(0, index + 1));
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT' && missing) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Snapshot paths must not contain symbolic links: ${path}`);
    const mustBeDirectory = index < parts.length - 1 || directory;
    if (mustBeDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Snapshot path has an unexpected file type: ${path}`);
    if (index === parts.length - 1) return stat;
  }
}

async function readSnapshot(root) {
  const manifestStat = await checkPath(root, MANIFEST);
  if (manifestStat.size > MAX_FILE_BYTES) throw new Error('Source manifest is too large.');
  const manifestBuffer = await readFile(resolve(root, MANIFEST));
  const manifest = parseManifest(manifestBuffer);
  const buffers = new Map([[MANIFEST, manifestBuffer]]);
  let total = manifestBuffer.length;
  for (const path of [STRINGS, ...manifest.resources.map(resource => `${SITE}/${resource.path}`)]) {
    const stat = await checkPath(root, path);
    total += stat.size;
    if (stat.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Source snapshot exceeds the size limit.');
    buffers.set(path, await readFile(resolve(root, path)));
  }
  return { ...validateBuffers(buffers), buffers };
}

/** Verify local bytes, count metadata, source hashes, and the strings hash. */
export async function verifySnapshot(root = PROJECT_ROOT) {
  const { buffers, ...result } = await readSnapshot(resolve(root));
  return result;
}

async function writeBuffers(root, buffers) {
  for (const [path, data] of buffers) {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
  }
}

/** Export precisely the manifest-listed source, never settings or translations. */
export async function exportSnapshot({ root = PROJECT_ROOT, output = 'artifacts/musicmap-source.tar.gz' } = {}) {
  root = resolve(root);
  const destination = resolve(root, output);
  if (!/\.(?:tar\.gz|tgz)$/i.test(destination)) throw new Error('Snapshot output must end in .tar.gz or .tgz.');
  const target = relative(root, destination).replaceAll('\\', '/');
  if (['.cache', 'generated', 'public', 'dist', 'locales'].some(path => target === path || target.startsWith(`${path}/`))) {
    throw new Error('Store snapshots outside source, translation, and build directories; artifacts/ is recommended.');
  }
  const { buffers, ...snapshot } = await readSnapshot(root);
  const staging = await mkdtemp(join(root, '.snapshot-export-'));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeBuffers(staging, buffers);
    await mkdir(dirname(destination), { recursive: true });
    await createTar({ file: temporary, cwd: staging, gzip: true, portable: true, noMtime: true, strict: true, noDirRecurse: true }, snapshot.files);
    await rename(temporary, destination);
    return { output: destination, fingerprint: snapshot.fingerprint, resourceCount: snapshot.manifest.resourceCount, stringCount: snapshot.manifest.stringCount, bytes: (await lstat(destination)).size };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
}

async function readArchive(archive) {
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOTAL_BYTES) throw new Error('Snapshot archive must be a regular file within the size limit.');
  const buffers = new Map();
  const entries = new Set();
  let total = 0;
  await new Promise((done, reject) => {
    const input = createReadStream(archive);
    const parser = new Parser({ strict: true, maxDecompressionRatio: 1000 });
    const fail = error => { input.destroy(); reject(error); };
    parser.on('error', fail);
    input.on('error', error => parser.abort(error));
    parser.on('end', done);
    parser.on('entry', entry => {
      try {
        const path = entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path;
        safeRelativePath(path);
        if (entries.has(path) || entries.size >= MAX_ENTRIES) throw new Error('Snapshot contains duplicate or too many entries.');
        entries.add(path);
        if (entry.type === 'Directory') {
          if (!(path === 'generated' || path === '.cache' || path === '.cache/source' || path === SITE || path.startsWith(`${SITE}/`))) throw new Error('Snapshot contains an unexpected directory.');
          entry.resume();
          return;
        }
        if (entry.type !== 'File') throw new Error('Snapshot must not contain links, devices, or special files.');
        if (!allowedFile(path)) throw new Error('Snapshot contains a file outside the source allowlist.');
        total += entry.size;
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Snapshot exceeds the size limit.');
        const chunks = [];
        entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
        entry.on('end', () => buffers.set(path, Buffer.concat(chunks)));
        entry.resume();
      } catch (error) { parser.abort(error); }
    });
    input.pipe(parser);
  });
  return buffers;
}

async function replaceSource(root, staging) {
  const targets = [SITE, STRINGS, MANIFEST];
  const changes = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const path = targets[index];
      const existing = await checkPath(root, path, { missing: true, directory: path === SITE });
      const target = resolve(root, path);
      const backup = join(staging, `backup-${index}`);
      await mkdir(dirname(target), { recursive: true });
      if (existing) await rename(target, backup);
      const change = { target, backup, existed: Boolean(existing), installed: false };
      changes.push(change);
      await rename(resolve(staging, 'contents', path), target);
      change.installed = true;
    }
  } catch (error) {
    for (const change of changes.reverse()) {
      if (change.installed) await rm(change.target, { recursive: true, force: true });
      if (change.existed) await rename(change.backup, change.target);
    }
    throw error;
  }
}

/** Import only after complete in-memory validation, with rollback on file errors. */
export async function importSnapshot({ root = PROJECT_ROOT, archive, force = false } = {}) {
  if (!archive) throw new Error('Provide the source snapshot archive to import.');
  root = resolve(root);
  const buffers = await readArchive(resolve(root, archive));
  const snapshot = validateBuffers(buffers);
  let exists = false;
  for (const path of [SITE, MANIFEST, STRINGS]) {
    if (await checkPath(root, path, { missing: true, directory: path === SITE })) exists = true;
  }
  if (exists) {
    let current;
    try { current = await readSnapshot(root); } catch {
      if (!force) throw new Error('Existing source is incomplete or invalid. Use --force to replace source files only.');
    }
    if (current?.fingerprint === snapshot.fingerprint) return { ...snapshot, unchanged: true };
    if (!force) throw new Error('Existing source differs from this snapshot. Use --force to replace source files only.');
  }
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, '.snapshot-import-'));
  try {
    await writeBuffers(join(staging, 'contents'), buffers);
    await replaceSource(root, staging);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { ...snapshot, unchanged: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'export') {
      const outputIndex = args.indexOf('--output');
      if (outputIndex !== -1 && !args[outputIndex + 1]) throw new Error('--output requires an archive path.');
      const result = await exportSnapshot({ output: outputIndex === -1 ? undefined : args[outputIndex + 1] });
      console.log(`Exported ${result.resourceCount} source files and ${result.stringCount} strings to ${result.output}`);
      console.log(`Source fingerprint: ${result.fingerprint}`);
    } else if (command === 'import') {
      const result = await importSnapshot({ archive: args.find(arg => arg !== '--force'), force: args.includes('--force') });
      console.log(`${result.unchanged ? 'Already present' : 'Imported'}: ${result.manifest.resourceCount} source files, ${result.manifest.stringCount} strings.`);
      console.log(`Source fingerprint: ${result.fingerprint}`);
    } else {
      throw new Error('Usage: node scripts/snapshot.mjs export [--output artifacts/musicmap-source.tar.gz] | import <archive> [--force]');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
