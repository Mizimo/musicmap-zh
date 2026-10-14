// Inspect the actual continuation build. No translation API or report generation.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { stripChapterMarkers } from '../public/chapter-renderer.js';
const run=resolve(process.argv[2]??'artifacts/chapter-continuation/2026-10-14-body-50pct');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const catalog=await json(resolve(run,'workspace/.cache/source/units.json'));
const genres=await json(resolve(run,'workspace/generated/site/master-genrelist.json'));
const buildEvidence=await json(resolve(run,'build-verification.json'));
const locales=Object.fromEntries(await Promise.all(['zh-Hans','zh-Hant'].map(async lang=>[lang,await json(resolve(run,`workspace/dist/_zh/locales/${lang}.json`))])));
const uniqueBody=[...new Set(catalog.units.map(u=>u.source))];
assert.equal(uniqueBody.length,562);
for(const locale of Object.values(locales)){
 assert.equal(Object.keys(locale).length,buildEvidence.bodyCompleted);
 assert.equal(uniqueBody.filter(s=>locale[s]).length,buildEvidence.bodyCompleted);
 assert.ok(Object.keys(locale).every(s=>uniqueBody.includes(s)));
}
const site=createApp({directory:resolve(run,'workspace/dist')});
await new Promise(done=>site.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${site.address().port}`;
const errors=[],requests=[],checks=[],staticChecks=[];let browser;
const compact=s=>s.replace(/\s+/g,'');
async function navigate(page,code){
 await page.evaluate(code=>{const family=document.querySelector(`#supergenres-list [data-code="${code}"]`);
  if(family)family.click();else{const select=document.querySelector('#genres-searchbox');select.value=code;
   if(select.value===code)document.querySelector('#genres-navigate-button').click();
   else{const map=document.querySelector(`#main-genres text[data-code="${code}"]`);
    if(!map)throw new Error(`Original navigation missing ${code}`);
    map.dispatchEvent(new MouseEvent('click',{bubbles:true}));}}},code);
}
try{
 browser=await chromium.launch({headless:true});
 for(const [device,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport});const page=await context.newPage();
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Unable to render validated chapter'))errors.push(m.text());});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin,{waitUntil:'networkidle'});
  console.log(JSON.stringify({device,stage:'loaded'}));
  await expect(page.locator('#mmzh-root #status')).not.toContainText('載入');
  assert.match(await page.locator('#mmzh-root #status').textContent(),/未完成|未完成翻譯|partial|\d+.*1900/i);
  const geometry=await page.locator('#main-genres text[data-code]').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('data-code'),n.getAttribute('transform'),n.querySelectorAll('tspan').length]));
  for(const lang of ['en','zh-Hans','zh-Hant']){
   await page.locator(`#mmzh-root [data-lang="${lang}"]`).click();
   assert.deepEqual(await page.locator('#main-genres text[data-code]').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('data-code'),n.getAttribute('transform'),n.querySelectorAll('tspan').length])),geometry);
   const expected=catalog.units.filter(u=>u.kind==='page').flatMap(u=>u.targets.map(target=>({id:u.id,selector:target.selector,html:u.html,
    text:lang==='en'||!locales[lang][u.source]?u.plainText:stripChapterMarkers(locales[lang][u.source]),translated:!!locales[lang]?.[u.source]})));
   await expect.poll(async()=>await page.evaluate(({expected,lang})=>expected.flatMap(u=>{
    const original=document.querySelector(u.selector);if(!original)return [`${u.id}: target absent`];
    const node=original.cloneNode(true);
    // Original bundle inserts illustration SVGs beside these English captions.
    // Those illustrations are absent from the frozen caption's source HTML.
    if(['#genres-relations','#supergenres-blueprint'].includes(u.selector))node.querySelectorAll('svg').forEach(svg=>svg.remove());
    const compact=s=>s.replace(/\s+/g,'');
    const mismatch=compact(node.textContent)!==compact(u.text)?[`${u.id}: text differs`]:[];
    if(lang==='en'){const div=document.createElement('div');div.innerHTML=u.html;if(node.innerHTML!==div.innerHTML)mismatch.push(`${u.id}: English HTML differs`);}
    return mismatch;
   }),{expected,lang})).toEqual([]);
   staticChecks.push({device,language:lang,mappings:expected.length,translated:expected.filter(x=>x.translated).length,englishFallback:expected.filter(x=>!x.translated).length});
   console.log(JSON.stringify({device,language:lang,stage:'static-verified'}));
  }
  const consent=page.locator('#privacy-policy-accept-btn');if(await consent.isVisible())await consent.click();
  await page.locator('#genres-navigate-button:not([disabled])').waitFor({state:'attached'});
  const body=catalog.units.filter(u=>u.kind==='genre');
  const sample=body.filter((u,i)=>i%25===0||['alt02','met','inl','inl09','inr01','inr11'].includes(u.genreId));
  for(const lang of ['zh-Hans','zh-Hant','en']){
   const selected=device==='desktop'&&lang==='zh-Hans'&&!process.argv.includes('--sample-only')?body:sample;
   await page.locator(`#mmzh-root [data-lang="${lang}"]`).click();
   for(const unit of selected){
    const family=Array.isArray(genres[unit.genreId].genrelist);
    const pane=page.locator(family?'#supergenre-side-pane-genre-description':'#right-side-pane-genre-description');
    const canonicalId=body.find(u=>u.plainText===unit.plainText).id;
    await navigate(page,unit.genreId);await expect(pane).toHaveAttribute('data-mmzh-chapter',canonicalId);
    const translated=!!locales[lang]?.[unit.source];const expected=translated?stripChapterMarkers(locales[lang][unit.source]):unit.plainText;
    await expect.poll(async()=>compact(await pane.textContent())).toBe(compact(expected));
    if(lang==='en'){
     const canonical=await page.evaluate(html=>{const d=document.createElement('div');d.innerHTML=html;return d.innerHTML;},unit.html);
     assert.equal(await pane.innerHTML(),canonical);
    }else{
     const links=await pane.evaluate((node,html)=>{const d=document.createElement('div');d.innerHTML=html;
      const attrs=root=>[...root.querySelectorAll('a')].map(a=>JSON.stringify([a.getAttribute('href'),a.getAttribute('data-code'),a.getAttribute('target')])).sort();
      return {actual:attrs(node),expected:attrs(d)};},unit.html);
     assert.deepEqual(links.actual,links.expected);
    }
    checks.push({device,language:lang,unitId:unit.id,translated});
    if(checks.length%50===0)console.log(JSON.stringify({device,language:lang,totalChecks:checks.length,unitId:unit.id}));
   }
   console.log(JSON.stringify({device,language:lang,genreMappingsChecked:selected.length}));
  }
  await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
  await page.locator('#musicmap-button').click();const before=await page.locator('#viewport').getAttribute('transform');
  if(device==='desktop')await page.locator('#zoom-in').click();else{await page.mouse.move(180,240);await page.mouse.wheel(0,-400);}
  await expect(page.locator('#viewport')).not.toHaveAttribute('transform',before??'');
  await page.locator('#mmzh-root #open-search').click();await page.locator('#mmzh-root #search').fill('Noise Rock');
  await expect(page.locator('#mmzh-root #results button').first()).toBeVisible();await page.locator('#mmzh-root #results button').first().click();
  await expect(page.locator('#right-side-pane-genre-description')).toHaveAttribute('data-mmzh-chapter','genre:alt02');
  const fresh=body.find(u=>u.genreId==='inl'&&locales['zh-Hant'][u.source]);
  if(fresh){await navigate(page,fresh.genreId);await expect(page.locator('#supergenre-side-pane-genre-description')).toHaveAttribute('data-mmzh-chapter',fresh.id);}
  await page.screenshot({path:resolve(run,`preview-${device}.png`)});
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.ok(!requests.some(url=>/api\.deepseek\.com/.test(url)));
 const evidence={passed:true,verifiedAt:new Date().toISOString(),bodyCompleted:buildEvidence.bodyCompleted,bodyTotal:562,
  genreLanguageChecks:checks.length,checks,staticChecks,englishExactRestore:true,inlineLinkAttributesPreserved:true,
  originalNavigation:true,sourceSvgPreserved:true,mapZoom:{desktop:'original button',mobile:'wheel'},
  missingWholeBodyEnglishFallback:true,partialLabelVisible:true,externalNetworkBlocked:true,deepseekBrowserRequests:0,
  inheritedBaselineLimitations:['At 390px the original reader toolbar covers the original zoom-in button; original UI is retained and wheel zoom was verified.'],errors};
 await writeFile(resolve(run,'browser-verification.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:true,bodyCompleted:buildEvidence.bodyCompleted,genreLanguageChecks:checks.length,staticMappings:staticChecks.reduce((n,x)=>n+x.mappings,0),errors:0}));
}finally{await browser?.close();await new Promise(done=>site.close(done));}
