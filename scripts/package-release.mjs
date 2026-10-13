#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create as createTar } from 'tar';
import { CONVERTER, hashLocale, sourceHash } from '../lib/chinese-conversion.mjs';
import { prepareBundle, prepareHTML } from './build.mjs';
import { validateFrozenManifest } from './production.mjs';
import { verifySnapshot } from './snapshot.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const languages = ['zh-Hans', 'zh-Hant'];
const finalizationSteps = ['merge', 'convert', 'build', 'test:browser'];
const extraDistFiles = ['_zh/overlay.js', '_zh/overlay.css', '_zh/dictionary.js', '_zh/locales/zh-Hans.json', '_zh/locales/zh-Hant.json', '_zh/translation-status.json'];

export class ReleaseError extends Error {
  constructor(code, message) { super(message); this.name = 'ReleaseError'; this.code = code; }
}
const fail = (code, message) => { throw new ReleaseError(code, message); };

function safePath(value) {
  if (typeof value !== 'string' || !value || /[\\\0\r\n:]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('UNSAFE_PATH', 'The release contains an unsafe path.');
  }
  return value;
}

async function readRegular(rootDir, path) {
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const info = await lstat(join(rootDir, ...parts.slice(0, index + 1)));
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      fail('UNSAFE_FILE', `Release input must be a regular file without symbolic links: ${path}.`);
    }
  }
  return readFile(join(rootDir, path));
}

async function readJson(rootDir, path) {
  try { return JSON.parse((await readRegular(rootDir, path)).toString('utf8')); }
  catch (error) {
    if (error instanceof ReleaseError) throw error;
    fail('INVALID_INPUT', `Cannot read valid release metadata: ${path}.`);
  }
}

async function distFiles(rootDir, directory = 'dist') {
  const info = await lstat(join(rootDir, directory));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_FILE', 'The built site must be a regular directory without symbolic links.');
  const files = [];
  for (const entry of await readdir(join(rootDir, directory), { withFileTypes: true })) {
    const path = safePath(`${directory}/${entry.name}`);
    if (entry.isSymbolicLink()) fail('UNSAFE_FILE', 'The built site must not contain symbolic links.');
    if (entry.isDirectory()) files.push(...await distFiles(rootDir, path));
    else if (entry.isFile()) files.push(path);
    else fail('UNSAFE_FILE', 'The built site contains a device or another unsupported file type.');
  }
  return files.sort();
}

function requireCompleteCoverage(status, hash, total, label) {
  if (status?.sourceHash !== hash || status.total !== total ||
      languages.some((language) => status.languages?.[language]?.complete !== true || status.languages[language].translated !== total || status.languages[language].total !== total)) {
    fail('INCOMPLETE_COVERAGE', `${label} does not prove complete Simplified and Traditional Chinese coverage for the current source.`);
  }
}

/** Read and validate the complete deliverable without rebuilding, translating, or modifying it. */
export async function verifyRelease({ rootDir = PROJECT_ROOT } = {}) {
  rootDir = resolve(rootDir);
  try {
    await lstat(join(rootDir, 'generated/production/lock'));
    fail('PRODUCTION_ACTIVE', 'A production lock still exists. Package only after all production work has stopped.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const production = await readJson(rootDir, 'generated/production/status.json');
  if (production.state !== 'completed' || production.translationComplete !== true) fail('PRODUCTION_INCOMPLETE', 'Production is not complete; no website package was created.');
  const finalization = production.finalization;
  if (!Array.isArray(finalization) || finalization.length !== finalizationSteps.length ||
      finalization.some((step, index) => step.script !== finalizationSteps[index] || step.exitCode !== 0 || !Number.isFinite(Date.parse(step.finishedAt)))) {
    fail('VERIFICATION_INCOMPLETE', 'Successful merge, conversion, strict build, and browser verification are all required.');
  }
  const finishedAt = Date.parse(production.finishedAt);
  const browserFinishedAt = Date.parse(finalization.at(-1).finishedAt);
  if (!Number.isFinite(finishedAt) || finishedAt < browserFinishedAt || finalization.some((step, index) => index > 0 && Date.parse(step.finishedAt) < Date.parse(finalization[index - 1].finishedAt))) {
    fail('VERIFICATION_INCOMPLETE', 'Production verification timestamps are missing or out of order.');
  }
  const manifest = await readJson(rootDir, 'generated/production/manifest.json');
  const { source } = await validateFrozenManifest(manifest, { rootDir });
  const snapshot = await verifySnapshot(rootDir);
  const hash = sourceHash(source);
  const total = source.length;
  if (!total || snapshot.manifest.stringCount !== total || production.sourceHash !== hash || production.total !== total || production.translated !== total) {
    fail('SOURCE_MISMATCH', 'Production and the current source snapshot do not have the same complete coverage.');
  }
  const knownSource = new Set(source);
  const locales = {};
  for (const language of languages) {
    const locale = await readJson(rootDir, `generated/locales/${language}.json`);
    if (!locale || typeof locale !== 'object' || Array.isArray(locale) || Object.keys(locale).length !== total ||
        Object.entries(locale).some(([text, translated]) => !knownSource.has(text) || typeof translated !== 'string' || !translated.trim())) {
      fail('INCOMPLETE_LOCALE', `The actual ${language} locale contains missing, unknown, or empty translations.`);
    }
    locales[language] = locale;
  }
  const conversion = await readJson(rootDir, 'generated/conversion-status.json');
  const terminology = await readJson(rootDir, 'data/terminology.json');
  if (conversion.complete !== true || conversion.total !== total || conversion.converted !== total ||
      conversion.sourceHash !== hash || conversion.simplifiedHash !== hashLocale(locales['zh-Hans']) ||
      conversion.traditionalHash !== hashLocale(locales['zh-Hant']) || conversion.terminologyHash !== sha256(JSON.stringify(terminology)) ||
      Object.entries(CONVERTER).some(([key, value]) => conversion.converter?.[key] !== value)) {
    fail('STALE_CONVERSION', 'Traditional Chinese conversion is incomplete or stale. Reconvert, build, and verify before packaging.');
  }
  requireCompleteCoverage(await readJson(rootDir, 'generated/translation-status.json'), hash, total, 'Global translation metadata');
  const build = await readJson(rootDir, 'dist/_zh/translation-status.json');
  requireCompleteCoverage(build, hash, total, 'Built website metadata');
  if (!Number.isFinite(Date.parse(build.sourceDate)) || Date.parse(build.sourceDate) > Date.parse(finalization[2].finishedAt)) {
    fail('STALE_VERIFICATION', 'The built website is newer than the successful production build record. Verify the rebuilt site first.');
  }
  const paths = [...snapshot.manifest.resources.map((resource) => `dist/${safePath(resource.path)}`), ...extraDistFiles.map((path) => `dist/${path}`)].sort();
  const actual = await distFiles(rootDir);
  if (JSON.stringify(actual) !== JSON.stringify(paths)) fail('UNLISTED_BUILD_FILE', 'The built website has missing or unlisted files. Credentials and private work data must never enter a release.');
  const buffers = new Map();
  for (const path of paths) {
    const data = await readRegular(rootDir, path);
    const relativePath = path.slice('dist/'.length);
    let expected;
    if (relativePath === 'index.html') expected = Buffer.from(prepareHTML((await readRegular(rootDir, 'generated/site/index.html')).toString('utf8'), build));
    else if (relativePath === 'main.bundle.js') expected = Buffer.from(prepareBundle((await readRegular(rootDir, 'generated/site/main.bundle.js')).toString('utf8')));
    else if (relativePath.startsWith('_zh/locales/')) {
      const language = basename(relativePath, '.json');
      expected = Buffer.from(JSON.stringify(locales[language]));
    } else if (relativePath === '_zh/translation-status.json') expected = data;
    else if (relativePath.startsWith('_zh/')) expected = await readRegular(rootDir, `public/${basename(relativePath)}`);
    else expected = await readRegular(rootDir, `generated/site/${relativePath}`);
    if (!data.equals(expected)) fail('STALE_BUILD', `Built file does not match its verified current source: ${path}.`);
    if ((await lstat(join(rootDir, path))).mtimeMs > browserFinishedAt + 1) {
      fail('STALE_VERIFICATION', `A built file changed after browser verification: ${path}. Verify the rebuilt site first.`);
    }
    buffers.set(path, data);
  }
  buffers.set('server.mjs', await readRegular(rootDir, 'server.mjs'));
  return {
    rootDir, buffers, total, sourceHash: hash, sourceFingerprint: snapshot.fingerprint,
    sourceUrl: snapshot.manifest.sourceUrl, model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort,
    productionCommit: manifest.gitCommit, buildDate: build.sourceDate,
    verifiedAt: finalization.at(-1).finishedAt, productionFinishedAt: production.finishedAt,
    conversion: {
      sourceHash: conversion.sourceHash, simplifiedHash: conversion.simplifiedHash,
      traditionalHash: conversion.traditionalHash, terminologyHash: conversion.terminologyHash,
      converter: { ...CONVERTER },
    },
  };
}

function releaseReadme(total) {
  return `# Musicmap 完整簡繁中文閱讀版\n\n已預先完成 ${total} 個來源片段的簡體翻譯，繁體由本機 OpenCC 與音樂術語校正產生；介面可切換簡體、繁體與英文。閱讀與切換語言不需要 API Key，也不會呼叫翻譯 API。\n\n## 本機啟動\n\n需要 Node.js 22 或更新版本。解壓後，在本檔所在資料夾執行：\n\n\`\`\`bash\nnode server.mjs\n\`\`\`\n\n瀏覽器開啟 http://localhost:4173 。不需要 npm install。伺服器僅監聽本機 127.0.0.1；結束時按 Ctrl+C。\n\n也可使用 Python 3：\n\n\`\`\`bash\npython3 -m http.server 4173 --bind 127.0.0.1 --directory dist\n\`\`\`\n\n請經由 HTTP 開啟；不要直接雙擊 dist/index.html。若使用其他靜態伺服器，將 dist/ 設為網站根目錄，勿掛在子路徑。原站地圖、語言檔與所需本機資產均在 dist/；YouTube、Spotify 及外站連結仍需要網路。\n\n## 檔案驗證\n\nSHA256SUMS.txt 列出所有交付檔案（不含校驗表本身）的 SHA-256。在目前資料夾執行：\n\n\`\`\`bash\nsha256sum -c SHA256SUMS.txt\n# macOS 可改用：shasum -a 256 -c SHA256SUMS.txt\n\`\`\`\n\nRELEASE-MANIFEST.json 記錄來源、簡繁及術語 hash、轉換版本、建置與瀏覽器驗收時間。完整度及功能驗證不代表人工文字品質評分。\n\n來源與署名見 SOURCE.txt 及網站內原有資訊。\n`;
}

/** Create an allowlisted static-site archive; never traverse private runtime directories. */
export async function packageRelease({ rootDir = PROJECT_ROOT, output, date = new Date() } = {}) {
  rootDir = resolve(rootDir);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('INVALID_DATE', 'The release date is invalid.');
  const destination = resolve(rootDir, output ?? `artifacts/musicmap-zh-complete-${date.toISOString().slice(0, 10)}.tar.gz`);
  const localOutput = relative(rootDir, destination).replaceAll('\\', '/');
  if (!/^artifacts\//.test(localOutput) || !/\.tar\.gz$/.test(destination) || !/^[A-Za-z0-9._-]+$/.test(basename(destination))) {
    fail('INVALID_OUTPUT', 'Write the release to artifacts/ with a plain filename ending in .tar.gz.');
  }
  const verified = await verifyRelease({ rootDir });
  const buffers = new Map(verified.buffers);
  buffers.set('README.md', Buffer.from(releaseReadme(verified.total)));
  buffers.set('SOURCE.txt', Buffer.from('Original website: Musicmap — https://musicmap.info/\nThis is an unofficial local Chinese reading version. Original website credits, source links, and copyright notices remain in dist/index.html.\nOriginal content and website assets belong to their respective owners. This archive does not grant a new license to republish them.\nSimplified Chinese was prepared with DeepSeek V4 Pro / Max; Traditional Chinese is derived locally with OpenCC and project terminology preferences.\n'));
  const files = [...buffers].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) }));
  const releaseManifest = {
    schemaVersion: 1, createdAt: date.toISOString(), sourceUrl: verified.sourceUrl,
    sourceHash: verified.sourceHash, sourceFingerprint: verified.sourceFingerprint,
    translation: { total: verified.total, languages: [...languages, 'en'], model: verified.model, reasoningEffort: verified.reasoningEffort, complete: true },
    conversion: verified.conversion, productionCommit: verified.productionCommit,
    verification: { strictBuild: true, buildDate: verified.buildDate, browserPassedAt: verified.verifiedAt, productionCompletedAt: verified.productionFinishedAt },
    files,
  };
  buffers.set('RELEASE-MANIFEST.json', Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`));
  buffers.set('SHA256SUMS.txt', Buffer.from([...buffers].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => `${sha256(data)}  ${path}\n`).join('')));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.release-staging-'));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const checksumFile = `${destination}.sha256`;
  const temporaryChecksum = `${checksumFile}.${randomUUID()}.tmp`;
  let archiveInstalled = false;
  let checksumInstalled = false;
  try {
    for (const path of [destination, checksumFile]) {
      try { await lstat(path); fail('OUTPUT_EXISTS', 'A release archive or checksum already exists at the requested destination. Choose a different output filename.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const [path, data] of buffers) {
      const target = join(staging, 'musicmap-zh', safePath(path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx', mode: 0o644 });
    }
    await createTar({ file: temporary, cwd: staging, gzip: true, portable: true, noMtime: true, strict: true, noDirRecurse: true }, [...buffers.keys()].sort().map((path) => `musicmap-zh/${path}`));
    const archive = await readFile(temporary);
    const hash = sha256(archive);
    await writeFile(temporaryChecksum, `${hash}  ${basename(destination)}\n`, { flag: 'wx', mode: 0o600 });
    await link(temporary, destination);
    archiveInstalled = true;
    await link(temporaryChecksum, checksumFile);
    checksumInstalled = true;
    return { output: destination, checksumFile, sha256: hash, bytes: archive.length, files: buffers.size, total: verified.total, complete: true };
  } catch (error) {
    if (archiveInstalled && !checksumInstalled) await rm(destination, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporary, { force: true });
    await rm(temporaryChecksum, { force: true });
  }
}

export function parseReleaseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check') options.check = true;
    else if (args[index] === '--help' || args[index] === '-h') options.help = true;
    else if (args[index] === '--output' && args[index + 1] && !args[index + 1].startsWith('-')) options.output = args[++index];
    else fail('INVALID_ARGUMENTS', 'Usage: node scripts/package-release.mjs [--check] [--output artifacts/NAME.tar.gz]');
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseReleaseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/package-release.mjs [--check] [--output artifacts/NAME.tar.gz]\n\nRequires completed production, current complete locales and conversion, strict built files, and successful browser verification.\n--check validates without writing an archive. No API calls or builds are made.');
    else if (options.check) {
      const verified = await verifyRelease();
      console.log(JSON.stringify({ complete: true, total: verified.total, sourceHash: verified.sourceHash, verifiedAt: verified.verifiedAt }, null, 2));
    } else console.log(JSON.stringify(await packageRelease(options), null, 2));
  } catch (error) {
    console.error(error instanceof ReleaseError ? `Release stopped [${error.code}]: ${error.message}` : 'Release stopped: source, frozen inputs, or output files could not be verified. No complete package was issued.');
    process.exitCode = 1;
  }
}
