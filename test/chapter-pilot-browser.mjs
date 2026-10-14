// Verify the actual paid pilot's isolated static build and offline comparison report.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { stripChapterMarkers } from '../public/chapter-renderer.js';
const run=resolve(process.argv[2]??'artifacts/chapter-pilot/2026-10-14-pro-max-10');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const manifest=await json(resolve(run,'manifest.json'));
const catalog=await json(resolve(run,'workspace/.cache/source/units.json'));
const genres=await json(resolve(run,'workspace/generated/site/master-genrelist.json'));
const locales=Object.fromEntries(await Promise.all(['zh-Hans','zh-Hant'].map(async lang=>[lang,await json(resolve(run,`workspace/generated/locales/${lang}.json`))])));
const report=await json(resolve(run,'report-data.json'));
const site=createApp({directory:resolve(run,'workspace/dist')}),reportServer=createApp({directory:run});
for(const server of [site,reportServer])await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${site.address().port}`,reportOrigin=`http://127.0.0.1:${reportServer.address().port}`;
const errors=[],requests=[],checks=[];let browser;
const compact=s=>s.replace(/\s+/g,'');
async function pageFor(context,allowed){
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 page.on('console',msg=>{if(msg.type()==='error'&&msg.text().includes('Unable to render validated chapter'))errors.push(msg.text());});
 await page.route('**/*',route=>new URL(route.request().url()).origin===allowed?route.continue():route.abort());return page;
}
async function navigate(page,code){
 await page.evaluate(code=>{const family=document.querySelector(`#supergenres-list [data-code="${code}"]`);
  if(family)family.click();else{const select=document.querySelector('#genres-searchbox');select.value=code;
   if(select.value===code)document.querySelector('#genres-navigate-button').click();
   else {const map=document.querySelector(`#main-genres text[data-code="${code}"]`);
    if(!map)throw new Error(`Genre ${code} absent from original map navigation`);
    map.dispatchEvent(new MouseEvent('click',{bubbles:true}));}}},code);
}
try{
 browser=await chromium.launch({headless:true});
 for(const [device,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport});const page=await pageFor(context,origin);
  await page.goto(origin,{waitUntil:'networkidle'});
  const consent=page.locator('#privacy-policy-accept-btn');if(await consent.isVisible())await consent.click();
  await page.locator('#genres-navigate-button:not([disabled])').waitFor({state:'attached'});
  await expect(page.locator('#mmzh-root #status')).not.toContainText('載入');
  const svgBefore=await page.locator('#main-genres text[data-code]').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('data-code'),n.getAttribute('transform'),n.querySelectorAll('tspan').length]));
  // Language changes preserve map geometry. Native navigation itself legitimately
  // reparents selected genre labels into other SVG groups, so compare before navigation.
  for(const lang of ['en','zh-Hans','zh-Hant']){
   await page.locator(`#mmzh-root [data-lang="${lang}"]`).click();
   assert.deepEqual(await page.locator('#main-genres text[data-code]').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('data-code'),n.getAttribute('transform'),n.querySelectorAll('tspan').length])),svgBefore);
  }
  for(const selected of manifest.selected){
   const unit=catalog.units.find(u=>u.id===selected.unitId);const family=Array.isArray(genres[selected.chapterId].genrelist);
   const pane=page.locator(family?'#supergenre-side-pane-genre-description':'#right-side-pane-genre-description');
   for(const lang of ['zh-Hans','zh-Hant','en']){
    await page.locator(`#mmzh-root [data-lang="${lang}"]`).click();await navigate(page,selected.chapterId);
    await expect(pane).toHaveAttribute('data-mmzh-chapter',unit.id);
    const translation=locales[lang]?.[unit.source];
    const expected=lang==='en'||!translation?unit.plainText:stripChapterMarkers(translation);
    await expect.poll(async()=>compact(await pane.textContent())).toBe(compact(expected));
    if(lang==='en'){
     const canonical=await page.evaluate(html=>{const d=document.createElement('div');d.innerHTML=html;return d.innerHTML;},unit.html);
     assert.equal(await pane.innerHTML(),canonical);
    }
    checks.push({device,chapter:selected.chapterId,language:lang,translated:!!translation});
   }
  }
  const missing=catalog.units.find(u=>u.kind==='genre'&&!locales['zh-Hans'][u.source]);
  await page.locator('#mmzh-root [data-lang="zh-Hans"]').click();await navigate(page,missing.genreId);
  const missingPane=page.locator(Array.isArray(genres[missing.genreId].genrelist)?'#supergenre-side-pane-genre-description':'#right-side-pane-genre-description');
  await expect.poll(async()=>compact(await missingPane.textContent())).toBe(compact(missing.plainText));
  // Exercise the original map controls and the retained overlay search.
  await page.locator('#musicmap-button').click();const before=await page.locator('#viewport').getAttribute('transform');
  if(device==='desktop')await page.locator('#zoom-in').click();
  else {await page.mouse.move(180,240);await page.mouse.wheel(0,-400);}
  await expect(page.locator('#viewport')).not.toHaveAttribute('transform',before??'');
  await page.locator('#mmzh-root #open-search').click();
  await page.locator('#mmzh-root #search').fill('Noise Rock');await expect(page.locator('#mmzh-root #results button').first()).toBeVisible();
  await page.locator('#mmzh-root #results button').first().click();
  await expect(page.locator('#right-side-pane-genre-description')).toHaveAttribute('data-mmzh-chapter','genre:alt02');
  const rp=await pageFor(context,reportOrigin);await rp.goto(reportOrigin+'/report.html',{waitUntil:'networkidle'});
  await expect(rp.locator('#cards .card')).toHaveCount(10);
  for(const chapter of report.chapters){
   const card=rp.locator(`[data-chapter-id="${chapter.id}"]`);
   if(chapter.state==='completed')assert.equal(await card.locator('.column .translation').last().textContent(),chapter.newText);
  }
  await rp.locator('#query').fill('Noise Rock');await expect(rp.locator('#cards .card')).toHaveCount(1);await rp.locator('#query').fill('');
  await rp.locator('#filter').selectOption('issues');await expect(rp.locator('#cards .card')).toHaveCount(report.chapters.filter(c=>c.state!=='completed').length);
  await rp.locator('#filter').selectOption('all');
  await rp.locator('[data-view="usage"]').click();await expect(rp.locator('#usage')).toBeVisible();
  await rp.locator('[data-view="chapters"]').click();
  assert.equal(await rp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
  if(device==='desktop')await rp.screenshot({path:resolve(run,'report-preview.png')});
  const downloadPromise=rp.waitForEvent('download');await rp.locator('#download').click();const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'musicmap-chapter-comparison.csv');
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.ok(!requests.some(url=>/api\.deepseek\.com/.test(url)));
 const evidence={passed:true,verifiedAt:new Date().toISOString(),chapterLanguageChecks:checks.length,checks,
  reportCards:10,reportDevices:['1440px desktop','390px mobile'],reportSearch:true,reportIssuesFilter:true,
  reportCsvDownload:true,reportOverflow:false,sourceSvgPreserved:true,originalNavigation:true,mapZoom:{desktop:'original button',mobileViewport:'wheel'},
  inheritedBaselineLimitations:['At 390px the original fixed reader toolbar covers the original zoom-in button. Layout was preserved; wheel zoom was verified instead.'],
  englishExactRestore:true,missingChapterEnglishFallback:true,externalNetworkBlocked:true,deepseekBrowserRequests:0,errors};
 await writeFile(resolve(run,'browser-verification.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:true,chapterLanguageChecks:checks.length,reportCards:10,errors:0}));
}finally{await browser?.close();for(const server of [site,reportServer])await new Promise(done=>server.close(done));}
