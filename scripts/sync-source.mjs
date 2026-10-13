import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';

export const SOURCE_ORIGIN = 'https://musicmap.info';
export const TEXT_ATTRIBUTES = [
  'title', 'placeholder', 'aria-label', 'data-bs-original-title',
  'data-bs-content', 'data-live-search-placeholder',
];
export const EXCLUDED_SELECTOR = 'script,style,noscript,iframe,textarea,#right-side-pane-songlist,.song-title,#people-list';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_FILES = ['index.html', 'main.bundle.js', 'main.css', 'master-genrelist.json'];
const ASSET_EXTENSION = /\.(?:css|js|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|otf)$/i;
const MAX_RESOURCE_BYTES = 30 * 1024 * 1024;

export const normalizeText = text => String(text).replace(/\s+/g, ' ').trim();
const meaningful = text => text.length > 1 && /[a-zA-Z]{2}/.test(text);
const unique = strings => [...new Set(strings.filter(meaningful))];

/** Match the reader's text-node granularity, preserving every embedded link. */
export function extractHtmlStrings(html) {
  const $ = load(html);
  const strings = [];
  function visit(node) {
    if (node.type === 'text') {
      const text = normalizeText(node.data);
      if (meaningful(text)) strings.push(text);
      return;
    }
    if (node.type !== 'root' && $(node).is(EXCLUDED_SELECTOR)) return;
    for (const attribute of TEXT_ATTRIBUTES) {
      const text = normalizeText(node.attribs?.[attribute] || '');
      if (meaningful(text)) strings.push(text);
    }
    for (const child of node.children || []) visit(child);
  }
  visit($.root()[0]);
  return unique(strings);
}

/** Descriptions, linked genre labels, and whole names used by Chinese search. */
export function extractGenreStrings(genres) {
  const strings = [];
  for (const entry of Object.values(genres)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['name', 'description', 'supergenre-first-tag']) {
      if (typeof entry[key] === 'string') strings.push(...extractHtmlStrings(entry[key]));
    }
    if (typeof entry.name === 'string') {
      const $ = load(entry.name);
      strings.push(normalizeText($('body').text()));
    }
    const secondTag = entry['supergenre-second-tag'];
    if (Array.isArray(secondTag) && typeof secondTag[1] === 'string') {
      strings.push(...extractHtmlStrings(secondTag[1]));
    }
    for (const html of entry.genrelist || []) {
      if (typeof html === 'string') strings.push(...extractHtmlStrings(html));
    }
  }
  return unique(strings);
}

// Decode string literals without executing upstream JavaScript.
function decodeLiteral(literal) {
  return literal.slice(1, -1).replace(/\\(?:u([\da-fA-F]{4})|x([\da-fA-F]{2})|([\s\S]))/g, (_, unicode, hex, escaped) => {
    if (unicode || hex) return String.fromCharCode(parseInt(unicode || hex, 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r': '' })[escaped] ?? escaped;
  });
}

/** The bundle inserts SVG legends and diagrams containing additional labels. */
export function extractBundleStrings(bundle) {
  const strings = [];
  const literals = bundle.match(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g) || [];
  for (const literal of literals) {
    if (!/<(?:svg|text|tspan|p|h[1-6]|div|span|label|button)\b/i.test(literal)) continue;
    strings.push(...extractHtmlStrings(decodeLiteral(literal)));
  }
  return unique(strings);
}

/** Return local resource paths only; embedded media and other origins stay external. */
export function assetPath(reference, baseUrl = `${SOURCE_ORIGIN}/`) {
  if (typeof reference !== 'string' || !reference.trim() || reference.trim().startsWith('#')) return null;
  let url;
  try { url = new URL(reference.trim(), baseUrl); } catch { return null; }
  if (url.origin !== SOURCE_ORIGIN || url.username || url.password) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (!ASSET_EXTENSION.test(pathname) || /[\\\0]/.test(pathname)) return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) return null;
  return parts.join('/');
}

function cssReferences(css) {
  return [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(match => match[2]);
}

export function discoverAssetPaths(html = '', css = '', bundle = '') {
  const paths = new Set();
  const add = reference => { const path = assetPath(reference); if (path) paths.add(path); };
  const $ = load(html);
  $('[src],link[href],image[href],image[xlink\\:href]').each((_, element) => {
    for (const attribute of ['src', 'href', 'xlink:href']) add(element.attribs[attribute]);
  });
  $('[srcset]').each((_, element) => {
    for (const item of element.attribs.srcset.split(',')) add(item.trim().split(/\s+/)[0]);
  });
  for (const reference of cssReferences(css)) add(reference);
  $('[style]').each((_, element) => cssReferences(element.attribs.style).forEach(add));
  for (const match of bundle.matchAll(/(?:assets\/)[\w./%+-]+\.(?:css|js|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|otf)/gi)) add(match[0]);
  return [...paths].sort();
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function fetchResource(url, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'Musicmap-ZH-Local-Archive/1.0', Accept: '*/*' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok) {
        const error = new Error(`Source download failed: ${new URL(url).pathname} (HTTP ${response.status})`);
        error.retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw error;
      }
      if (Number(response.headers.get('content-length')) > MAX_RESOURCE_BYTES) {
        await response.body?.cancel();
        const error = new Error(`Source resource is too large: ${new URL(url).pathname}`);
        error.retryable = false;
        throw error;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_RESOURCE_BYTES) {
          const error = new Error(`Source resource is too large: ${new URL(url).pathname}`);
          error.retryable = false;
          throw error;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (!size) throw new Error(`Source resource was empty: ${new URL(url).pathname}`);
      return Buffer.concat(chunks);
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 2) break;
      await delay(300 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Fetch or resume a local source snapshot. No upstream content belongs in Git. */
export async function syncSource({ root = PROJECT_ROOT, force = false, fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  const site = resolve(root, 'generated/site');
  const resources = new Map();
  const sourceBuffers = new Map();
  async function download(path) {
    const destination = resolve(site, path);
    const sourceUrl = path === 'index.html' ? `${SOURCE_ORIGIN}/` : `${SOURCE_ORIGIN}/${path}`;
    let buffer;
    let cached = false;
    if (!force) {
      try { buffer = await readFile(destination); cached = buffer.length > 0; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!cached) {
      buffer = await fetchResource(sourceUrl, fetchImpl);
      await atomicWrite(destination, buffer);
    }
    sourceBuffers.set(path, buffer);
    resources.set(path, { path, sourceUrl, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), cached });
    onProgress({ path, bytes: buffer.length, cached });
  }
  // Four independent requests at a time. Mandatory failures abort the snapshot.
  const coreResults = await Promise.allSettled(CORE_FILES.map(download));
  const coreFailure = coreResults.find(result => result.status === 'rejected');
  if (coreFailure) throw coreFailure.reason;
  const html = sourceBuffers.get('index.html').toString('utf8');
  const css = sourceBuffers.get('main.css').toString('utf8');
  const bundle = sourceBuffers.get('main.bundle.js').toString('utf8');
  let genres;
  try { genres = JSON.parse(sourceBuffers.get('master-genrelist.json').toString('utf8')); } catch { throw new Error('The source genre dataset is not valid JSON.'); }
  if (!genres || Array.isArray(genres) || typeof genres !== 'object' || Object.keys(genres).length === 0) throw new Error('The source genre dataset is empty or malformed.');
  const queue = discoverAssetPaths(html, css, bundle).filter(path => !resources.has(path));
  const discovered = new Set([...resources.keys(), ...queue]);
  while (queue.length) {
    const batch = queue.splice(0, 4);
    const results = await Promise.allSettled(batch.map(download));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const path of batch.filter(path => path.endsWith('.css'))) {
      const baseUrl = `${SOURCE_ORIGIN}/${path}`;
      for (const reference of cssReferences(sourceBuffers.get(path).toString('utf8'))) {
        const child = assetPath(reference, baseUrl);
        if (child && !discovered.has(child)) { discovered.add(child); queue.push(child); }
      }
    }
  }
  const strings = unique([
    ...extractHtmlStrings(html),
    ...extractGenreStrings(genres),
    ...extractBundleStrings(bundle),
  ]);
  const longest = Math.max(0, ...strings.map(text => text.length));
  if (longest > 5000) throw new Error(`Source has a ${longest}-character text node; the translation pipeline needs explicit segmentation before continuing.`);
  const stringBytes = `${JSON.stringify(strings, null, 2)}\n`;
  await atomicWrite(resolve(root, '.cache/source/strings.json'), stringBytes);
  const manifest = {
    version: 1,
    sourceUrl: `${SOURCE_ORIGIN}/`,
    createdAt: new Date().toISOString(),
    siteDirectory: 'generated/site',
    stringsPath: '.cache/source/strings.json',
    stringsSha256: createHash('sha256').update(stringBytes).digest('hex'),
    genreCount: Object.keys(genres).length,
    stringCount: strings.length,
    characterCount: strings.reduce((total, text) => total + text.length, 0),
    longestString: longest,
    resourceCount: resources.size,
    resources: [...resources.values()].sort((a, b) => a.path.localeCompare(b.path)),
    notes: ['External YouTube, Spotify, social widgets and Google Fonts are not archived. The map and local icon fonts are included.'],
  };
  await atomicWrite(resolve(root, 'generated/source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = await syncSource({
      force: process.argv.includes('--force'),
      onProgress: ({ path, bytes, cached }) => console.log(`${cached ? 'Cached' : 'Fetched'} ${path} (${bytes} bytes)`),
    });
    console.log(`Source ready: ${manifest.resourceCount} files, ${manifest.genreCount} genres, ${manifest.stringCount} strings, ${manifest.characterCount} characters. Longest text: ${manifest.longestString}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
