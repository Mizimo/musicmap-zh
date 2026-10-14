import { readFile, writeFile, mkdir, cp, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONVERTER, hashLocale, sourceHash as hashSource } from '../lib/chinese-conversion.mjs';
import { TERMINOLOGY_HASH } from '../lib/terminology.mjs';
import { readUnitCatalog, isChapterSource, validateChapterTranslation } from '../lib/chapter-units.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Keep map navigation working when YouTube is blocked, offline, or still loading. */
export function prepareBundle(bundle) {
  // Discover the minified name from its role; never depend on a particular release's `Bn`.
  const callbacks = [...bundle.matchAll(/window\.onYouTubeIframeAPIReady\s*=\s*function\s*\(\s*\)\s*\{\s*([\w$]+)\s*=\s*new\s+YT\.Player\s*\(/g)];
  if (callbacks.length !== 1) throw new Error('Musicmap 的 YouTube 初始化結構已變更，請更新離線相容處理後重新建置。');
  const player = callbacks[0][1];
  const escapedPlayer = player.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constructors = /new\s+YT\.Player\s*\(/g;
  const methods = new RegExp(`(?<![\\w$])${escapedPlayer}\\.(\\w+)\\s*\\(`, 'g');
  const expected = { getPlayerState: 10, playVideoAt: 1, cuePlaylist: 2 };
  const actual = {};
  for (const match of bundle.matchAll(methods)) actual[match[1]] = (actual[match[1]] || 0) + 1;
  if ([...bundle.matchAll(constructors)].length !== 2 ||
      Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([method, count]) => actual[method] !== count)) {
    throw new Error('Musicmap 的 YouTube 呼叫結構已變更，請更新離線相容處理後重新建置。');
  }
  // The constructor expression is the entire assignment RHS at both known sites.
  // A missing API leaves a falsy player. Optional calls also cover the pre-ready player,
  // whose iframe API methods are not yet attached, while preserving `this` when ready.
  return bundle.replace(constructors, 'typeof YT!=="undefined"&&typeof YT.Player==="function"&&new YT.Player(')
    .replace(methods, (_, method) => `${player}?.${method}?.(`);
}

export function prepareHTML(html, status) {
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, script => {
    if (script.includes('navigator.userAgent') && script.includes('m.musicmap.info')) return '';
    if (/googletagmanager|gtag\(|fbAsyncInit|connect\.facebook\.net/.test(script)) {
      // Map click handlers still call this global after the analytics loader is removed.
      return script.includes('function gtag(') ? '<script>function gtag(){}</script>' : '';
    }
    return script;
  });
  const config = JSON.stringify({ mode: 'static', status }).replaceAll('<', '\\u003c');
  return html.replace(/<title>[\s\S]*?<\/title>/i, '<title>Musicmap 中文｜流行音樂風格地圖</title>')
    .replace('</head>', '<link rel="stylesheet" href="/_zh/overlay.css"></head>')
    .replace('</body>', `<script id="mmzh-config" type="application/json">${config}</script><script type="module" src="/_zh/overlay.js"></script></body>`);
}

export async function build({ projectRoot = root, allowPartial = false, outputDir = resolve(projectRoot, 'dist') } = {}) {
  const input = JSON.parse(await readFile(resolve(projectRoot, '.cache/source/strings.json'), 'utf8'));
  const sourceHash = hashSource(input);
  const catalog = await readUnitCatalog(projectRoot, input);
  let prior = {};
  try { prior = JSON.parse(await readFile(resolve(projectRoot, 'generated/translation-status.json'), 'utf8')); } catch {}
  const status = { sourceHash, total: input.length, sourceDate: new Date().toISOString(), languages: {} };
  if (catalog) { status.unitCatalogHash = catalog.catalogHash; status.units = catalog.stats; }
  const locales = {};
  for (const lang of ['zh-Hans', 'zh-Hant']) {
    try { locales[lang] = JSON.parse(await readFile(resolve(projectRoot, `generated/locales/${lang}.json`), 'utf8')); }
    catch { locales[lang] = {}; }
    for (const text of input) if (isChapterSource(text) && Object.hasOwn(locales[lang], text)) validateChapterTranslation(text, locales[lang][text]);
    const translated = input.filter(text => typeof locales[lang][text] === 'string' && locales[lang][text].trim()).length;
    status.languages[lang] = { translated, total: input.length, complete: translated === input.length && input.length > 0 };
  }
  const coverageComplete = Object.values(status.languages).every(value => value.complete);
  let conversion = {};
  try { conversion = JSON.parse(await readFile(resolve(projectRoot, 'generated/conversion-status.json'), 'utf8')) || {}; } catch {}
  const conversionFresh = conversion.complete === true && conversion.sourceHash === sourceHash &&
    conversion.simplifiedHash === hashLocale(locales['zh-Hans']) &&
    conversion.traditionalHash === hashLocale(locales['zh-Hant']) &&
    conversion.terminologyHash === TERMINOLOGY_HASH &&
    conversion.total === input.length && conversion.converted === input.length &&
    Object.entries(CONVERTER).every(([key, value]) => conversion.converter?.[key] === value) &&
    (!catalog || conversion.unitCatalogHash === catalog.catalogHash);
  status.languages['zh-Hant'].complete &&= conversionFresh;
  const complete = coverageComplete && conversionFresh;
  if (prior.sourceHash && prior.sourceHash !== sourceHash && !allowPartial) throw new Error('來源已更新，請依序執行 npm run translate、npm run convert。');
  if (!coverageComplete && !allowPartial) throw new Error('簡繁翻譯尚未全部完成。請先執行 npm run translate，再執行 npm run convert；開發預覽可加 --allow-partial。');
  if (!conversionFresh && !allowPartial) throw new Error('繁體轉換記錄缺失或已過期。請先完成 npm run translate，再執行 npm run convert；開發預覽可加 --allow-partial。');
  const staging = resolve(projectRoot, `.cache/build-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  await cp(resolve(projectRoot, 'generated/site'), staging, { recursive: true });
  await mkdir(resolve(staging, '_zh/locales'), { recursive: true });
  for (const file of ['overlay.js', 'overlay.css', 'dictionary.js']) await cp(resolve(projectRoot, 'public', file), resolve(staging, '_zh', file));
  try { await cp(resolve(projectRoot, 'public/chapter-renderer.js'), resolve(staging, '_zh/chapter-renderer.js')); }
  catch (error) { if (catalog || error.code !== 'ENOENT') throw error; }
  try { await cp(resolve(projectRoot, 'public/chapter-caption-renderer.js'), resolve(staging, '_zh/chapter-caption-renderer.js')); }
  catch (error) { if (catalog || error.code !== 'ENOENT') throw error; }
  if (catalog) await writeFile(resolve(staging, '_zh/units.json'), JSON.stringify(catalog));
  for (const [lang, locale] of Object.entries(locales)) await writeFile(resolve(staging, `_zh/locales/${lang}.json`), JSON.stringify(locale));
  const html = await readFile(resolve(staging, 'index.html'), 'utf8');
  await writeFile(resolve(staging, 'index.html'), prepareHTML(html, status));
  const bundle = await readFile(resolve(staging, 'main.bundle.js'), 'utf8');
  await writeFile(resolve(staging, 'main.bundle.js'), prepareBundle(bundle));
  await writeFile(resolve(staging, '_zh/translation-status.json'), JSON.stringify(status, null, 2));
  await mkdir(resolve(outputDir, '..'), { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await rename(staging, outputDir);
  console.log(`${complete ? '完整簡繁版' : '未完成翻譯的開發預覽'}已輸出至 ${outputDir}。瀏覽時不會呼叫翻譯 API。`);
  return status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ allowPartial: process.argv.includes('--allow-partial') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
