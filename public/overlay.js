import { dictionary } from './dictionary.js';

const config = JSON.parse(document.getElementById('mmzh-config').textContent);
const sourceKey = text => text.replace(/\s+/g, ' ').trim();
const normalize = text => sourceKey(text).toLowerCase();
const words = new Map(Object.entries(dictionary).map(([key, value]) => [normalize(key), value]));
const records = new Map();
const attributes = new Map();
const translated = new Map();
const originalWidths = new WeakMap();
let language = 'zh-Hant';
try { language = localStorage.getItem('mmzh-language') || language; } catch {}
if (!['en', 'zh-Hans', 'zh-Hant'].includes(language)) language = 'zh-Hant';
let scanning = false;
let timer;
let statusKind = 'loading';
let searchEntries = [];

const host = document.createElement('div');
host.id = 'mmzh-root';
const ui = host.attachShadow({ mode: 'open' });
ui.innerHTML = `<style>
 :host{font-family:Inter,"Noto Sans CJK TC",system-ui,sans-serif;color:#edf3f2;font-size:12px;letter-spacing:.02em}
 *{box-sizing:border-box}button,input{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer}
 .bar{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;background:#151b1eef;border:1px solid #3a494c;border-radius:15px;box-shadow:0 8px 35px #0007;backdrop-filter:blur(15px);white-space:nowrap}
 .brand{font-size:11px;letter-spacing:.16em;color:#9ae3d3;font-weight:700}.brand small{display:block;color:#9caaae;font-size:9px;letter-spacing:.06em;margin-top:3px;font-weight:400}
 .langs{display:flex;background:#080d10;border:1px solid #303c41;border-radius:8px;padding:3px;gap:2px}button{border:0;border-radius:5px;padding:7px 10px;color:#a8b7bc;background:transparent}button:hover{background:#2a373c;color:white}button[aria-pressed=true]{background:#b9edde;color:#142a25}
 .divider{height:26px;width:1px;background:#364246}.search-button{font-size:18px;padding:3px 8px}.status{color:#96a6aa;font-size:10px;max-width:170px;white-space:normal;line-height:1.5}.status[data-kind=error]{color:#ffbd9a}.dot{display:inline-block;width:5px;height:5px;border-radius:100%;background:#98cfba;margin-right:5px}
 .panel{position:absolute;bottom:75px;right:0;width:380px;max-width:calc(100vw - 24px);padding:20px;background:#151b1efc;border:1px solid #3a494c;border-radius:14px;box-shadow:0 8px 40px #0009;line-height:1.7} .panel[hidden]{display:none}.panel h2{font-size:16px;margin:0 0 12px}.panel p{color:#abb9bd;margin:8px 0}.panel input{width:100%;background:#080d10;color:#fff;border:1px solid #53666b;padding:10px;border-radius:7px;outline-offset:3px}.panel a{color:#b9edde}.panel code{color:#cbe7df;overflow-wrap:anywhere}.results{max-height:260px;overflow:auto;margin-top:10px}.result{display:block;width:100%;text-align:left;padding:10px;border-bottom:1px solid #29383d;border-radius:0}.result small{display:block;color:#91a6ab}.close{position:absolute;right:10px;top:8px;font-size:18px}.retry{padding:3px 6px;font-size:11px;text-decoration:underline}
 @media(max-width:620px){.bar{gap:7px;padding:8px 9px;justify-content:space-between}.brand{font-size:9px}.brand small{font-size:8px}.langs button{padding:7px}.status{display:none}.divider{display:none}.panel{bottom:68px;right:0}.search-button{padding:5px}.retry{font-size:10px}}
 </style>
 <section class="panel" id="search-panel" hidden><button class="close" aria-label="Close">×</button><h2 id="search-title"></h2><input id="search" type="search" autocomplete="off"><div class="results" id="results"></div></section>
 <section class="panel" id="help-panel" hidden><button class="close" aria-label="Close">×</button><h2 id="help-title"></h2><div id="help-copy"></div></section>
 <div class="bar"><div class="brand">MUSICMAP<small id="caption"></small></div><div class="langs" aria-label="Language"><button data-lang="zh-Hans">简体</button><button data-lang="zh-Hant">繁體</button><button data-lang="en">EN</button></div><span class="divider"></span><button class="search-button" id="open-search" aria-label="搜尋流派">⌕</button><div class="status" id="status" role="status" aria-live="polite"></div><button id="help" aria-label="閱讀說明">?</button></div>`;
document.body.append(host);
const $ = selector => ui.querySelector(selector);
const copy = (hans, hant, en) => language === 'en' ? en : language === 'zh-Hans' ? hans : hant;

function renderUI() {
  document.documentElement.dataset.mmzhLanguage = language;
  document.documentElement.lang = language;
  ui.querySelectorAll('[data-lang]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === language)));
  $('#caption').textContent = copy('非官方中文阅读版', '非官方中文閱讀版', 'UNOFFICIAL READER');
  $('#search-title').textContent = copy('寻找一种声音', '尋找一種聲音', 'Find a sound');
  $('#search').placeholder = copy('中文或英文流派名…', '中文或英文流派名…', 'Genre in Chinese or English…');
  $('#open-search').ariaLabel = $('#search-title').textContent;
  $('#help-title').textContent = copy('关于中文阅读版', '關於中文閱讀版', 'About this reader');
  $('#help-copy').innerHTML = '';
  for (const text of [
    copy('地图保留原站互动。中文名称可用搜索查找，切换 EN 可随时查看原文。', '地圖保留原站互動。中文名稱可用搜尋查找，切換 EN 可隨時查看原文。', 'The original map remains interactive. Search Chinese genre names, or switch to EN for the original.'),
    copy('译文已预先生成并随页面提供。浏览和切换语言不会调用 DeepSeek，也不会产生翻译费用。', '譯文已預先產生並隨頁面提供。瀏覽和切換語言不會呼叫 DeepSeek，也不會產生翻譯費用。', 'Translations are built in advance and included with the site. Browsing and switching languages never call DeepSeek.'),
    copy('机器译文仅供参考。歌曲和音乐人保留原名；播放音乐需要联网。地图与原始内容属于 Musicmap。', '機器譯文僅供參考。歌曲和音樂人保留原名；播放音樂需要連網。地圖與原始內容屬於 Musicmap。', 'Machine translations may need review. Artist and song names remain original; playback requires internet. Original map and content belong to Musicmap.'),
  ]) { const p = document.createElement('p'); p.textContent = text; $('#help-copy').append(p); }
  const link = document.createElement('a'); link.href = 'https://musicmap.info/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = copy('原站 Musicmap ↗', '原站 Musicmap ↗', 'Original Musicmap ↗'); $('#help-copy').append(link);
  updateStatus(statusKind === 'loading' || statusKind === 'error' ? statusKind : 'ready');
}

function updateStatus(kind, message) {
  statusKind = kind;
  const values = {
    loading: copy('正在载入译文…', '正在載入譯文…', 'Loading translations…'),
    ready: language === 'en' ? 'Original English' : config.status.languages[language]?.complete ? copy('完整静态译本', '完整靜態譯本', 'Complete static edition') : copy('开发预览 · 翻译未完成', '開發預覽 · 翻譯未完成', 'Preview · translations incomplete'),
    error: copy('译文文件载入失败，请刷新', '譯文檔案載入失敗，請重新整理', 'Unable to load translations · reload'),
  };
  $('#status').dataset.kind = kind;
  $('#status').textContent = message || values[kind];
  $('#status').title = message || values[kind];
}

function lookup(text, lang = language) {
  if (lang === 'en') return text;
  const entry = words.get(normalize(text));
  return entry ? entry[lang === 'zh-Hans' ? 0 : 1] : translated.get(`${lang}:${sourceKey(text)}`);
}

function fitMapText(element) {
  const text = element.closest('text');
  if (!text || !text.closest('#musicmap')) return;
  const limits = originalWidths.get(text);
  if (!limits) return;
  for (const [node, width, length, adjustment] of limits) {
    if (language === 'en') {
      length === null ? node.removeAttribute('textLength') : node.setAttribute('textLength', length);
      adjustment === null ? node.removeAttribute('lengthAdjust') : node.setAttribute('lengthAdjust', adjustment);
    } else {
      node.removeAttribute('textLength');
      if (width > 0 && node.getComputedTextLength() > width * 1.15) { node.setAttribute('textLength', width * 1.15); node.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    }
  }
}

function eligible(node) {
  const p = node.parentElement;
  return p && !p.closest('#mmzh-root,script,style,noscript,iframe,textarea,#right-side-pane-songlist,.song-title,#people-list') && /[a-zA-Z]{2}/.test(node.textContent) && node.textContent.trim().length > 1;
}

function collect() {
  for (const [node] of records) if (!node.isConnected) records.delete(node);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!eligible(node)) continue;
    let record = records.get(node);
    if (record && node.nodeValue === record.applied) continue;
    record = { original: node.nodeValue, applied: node.nodeValue };
    records.set(node, record);
    const mapText = node.parentElement.closest('#musicmap text');
    if (mapText && !originalWidths.has(mapText)) {
      const spans = [...mapText.querySelectorAll('tspan')];
      originalWidths.set(mapText, (spans.length ? spans : [mapText]).map(item => [item, item.getComputedTextLength(), item.getAttribute('textLength'), item.getAttribute('lengthAdjust')]));
      mapText.setAttribute('aria-label', mapText.textContent.trim());
    }
  }
  for (const element of document.querySelectorAll('[title],[placeholder],[aria-label],[data-bs-original-title],[data-bs-content],[data-live-search-placeholder]')) {
    if (element.closest('#mmzh-root')) continue;
    let record = attributes.get(element);
    if (!record) { record = {}; attributes.set(element, record); }
    for (const name of ['title', 'placeholder', 'aria-label', 'data-bs-original-title', 'data-bs-content', 'data-live-search-placeholder']) {
      const value = element.getAttribute(name);
      if (value && (!record[name] || value !== record[name].applied)) record[name] = { original: value, applied: value };
    }
  }
}

function apply() {
  const mapTexts = new Set();
  for (const [node, record] of records) {
    const original = record.original.trim();
    const value = lookup(original) || original;
    const padded = record.original.replace(original, () => value);
    if (node.nodeValue !== padded) node.nodeValue = padded;
    record.applied = padded;
    if (node.parentElement?.closest('#musicmap text')) mapTexts.add(node.parentElement);
  }
  for (const [element, record] of attributes) {
    if (!element.isConnected) { attributes.delete(element); continue; }
    for (const [name, value] of Object.entries(record)) {
      value.applied = lookup(value.original) || value.original;
      if (element.getAttribute(name) !== value.applied) element.setAttribute(name, value.applied);
    }
  }
  mapTexts.forEach(fitMapText);
}

function scan() {
  if (scanning) return;
  scanning = true;
  observer.disconnect();
  collect(); apply();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scanning = false;
}
function schedule() { clearTimeout(timer); timer = setTimeout(scan, 220); }
const observer = new MutationObserver(mutations => {
  if (mutations.some(m => !host.contains(m.target) && !(m.type === 'characterData' && records.get(m.target)?.applied === m.target.nodeValue))) schedule();
});

async function loadSearch() {
  if (searchEntries.length) return;
  const response = await fetch('/master-genrelist.json');
  if (!response.ok) throw new Error('Unavailable');
  const source = await response.json();
  searchEntries = Object.entries(source).map(([code, entry]) => {
    const parsed = new DOMParser().parseFromString(entry.name, 'text/html');
    return { code, name: parsed.body.textContent.trim(), supergenre: entry.supergenre };
  });
}
function renderSearch() {
  const query = normalize($('#search').value);
  $('#results').replaceChildren();
  const matches = searchEntries.filter(entry => [entry.name, lookup(entry.name, 'zh-Hans'), lookup(entry.name, 'zh-Hant')].some(name => name && normalize(name).includes(query))).slice(0, 40);
  if (!matches.length) { $('#results').textContent = copy('没有匹配的流派；未翻译的名称可用英文搜寻。', '沒有符合的流派；未翻譯的名稱可用英文搜尋。', 'No matching genres. Try an English name.'); return; }
  for (const entry of matches) {
    const button = document.createElement('button'); button.className = 'result';
    const name = lookup(entry.name) || entry.name;
    button.textContent = name;
    if (name !== entry.name) { const small = document.createElement('small'); small.textContent = entry.name; button.append(small); }
    button.addEventListener('click', () => {
      const navigate = document.querySelector('#genres-navigate-button');
      if (!navigate || navigate.disabled) {
        $('#results').textContent = copy('地图正在启动，请稍后重新搜索。', '地圖正在啟動，請稍後重新搜尋。', 'The map is starting. Please search again in a moment.');
        return;
      }
      const target = [...document.querySelectorAll('#main-genres text[data-code]')].find(el => el.dataset.code === entry.code);
      if (target) {
        const select = document.querySelector('#genres-searchbox');
        select.value = entry.code;
        if (select.value) navigate.click();
        else target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      } else {
        const link = [...document.querySelectorAll('#supergenres-list [data-code]')].find(el => el.dataset.code === entry.code);
        link?.click();
      }
      $('#search-panel').hidden = true;
      schedule();
    });
    $('#results').append(button);
  }
}

ui.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => {
  language = button.dataset.lang;
  try { localStorage.setItem('mmzh-language', language); } catch {}
  renderUI(); scan(); if (!$('#search-panel').hidden) renderSearch();
}));
$('#help').addEventListener('click', () => { $('#help-panel').hidden = !$('#help-panel').hidden; $('#search-panel').hidden = true; });
ui.querySelectorAll('.close').forEach(button => button.addEventListener('click', () => { button.parentElement.hidden = true; }));
$('#open-search').addEventListener('click', async () => {
  $('#search-panel').hidden = !$('#search-panel').hidden; $('#help-panel').hidden = true;
  if ($('#search-panel').hidden) return;
  $('#search').focus();
  try { await loadSearch(); renderSearch(); } catch { $('#results').textContent = copy('无法载入流派，请稍后重试。', '無法載入流派，請稍後重試。', 'Unable to load genres. Please retry.'); }
});
$('#search').addEventListener('input', renderSearch);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#search-panel').hidden = true; $('#help-panel').hidden = true; } });
document.addEventListener('click', schedule);
document.addEventListener('scroll', schedule, true);
window.addEventListener('resize', schedule);
renderUI(); scan();
Promise.all(['zh-Hans', 'zh-Hant'].map(async lang => {
  const response = await fetch(`/_zh/locales/${lang}.json`);
  if (!response.ok) throw new Error('Unable to load locale');
  const entries = await response.json();
  for (const [original, translation] of Object.entries(entries)) {
    if (typeof translation === 'string') translated.set(`${lang}:${sourceKey(original)}`, translation);
  }
})).then(() => { updateStatus('ready'); scan(); }).catch(() => updateStatus('error'));
