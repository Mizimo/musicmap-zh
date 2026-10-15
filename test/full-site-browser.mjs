// Exhaustive full-site verification against the frozen catalog and formal build.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';
import { stripChapterMarkers } from '../public/chapter-renderer.js';
import { treeHashes, sha256 } from '../lib/full-site-parent.mjs';
const run=resolve(process.argv[2]??'artifacts/full-site/2026-10-15-complete');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const catalog=await json(resolve(run,'workspace/.cache/source/units.json'));
const genres=await json(resolve(run,'workspace/generated/site/master-genrelist.json'));
const buildEvidence=await json(resolve(run,'build-verification.json'));
const locales=Object.fromEntries(await Promise.all(['zh-Hans','zh-Hant'].map(async lang=>[lang,await json(resolve(run,`workspace/dist/_zh/locales/${lang}.json`))])));
const uniqueBody=[...new Set(catalog.units.map(u=>u.source))];
assert.equal(uniqueBody.length,562);
for(const locale of Object.values(locales)){
 assert.equal(Object.keys(locale).length,1900);
 assert.equal(uniqueBody.filter(s=>locale[s]).length,buildEvidence.bodyCompleted);
 assert.ok(catalog.source.every(s=>typeof locale[s]==='string'&&locale[s].trim()));
}
assert.equal(buildEvidence.partial,false);assert.equal(buildEvidence.formalBuild,true);
assert.equal(buildEvidence.bodyCompleted,562);assert.equal(buildEvidence.labelsCompleted,1338);
const builtHashes=await treeHashes(resolve(run,'workspace/dist'));
const site=createApp({directory:resolve(run,'workspace/dist')});
await new Promise(done=>site.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${site.address().port}`;
const errors=[],requests=[],checks=[],staticChecks=[],labelChecks=[],captionChecks=[];let browser;
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
 // Two independent read-only browser contexts; the paid worker stays serial.
 await Promise.all([['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]].map(async([device,viewport])=>{
  const context=await browser.newContext({viewport});const page=await context.newPage();
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Unable to render validated chapter'))errors.push(m.text());});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin,{waitUntil:'networkidle'});
  console.log(JSON.stringify({device,stage:'loaded'}));
  await expect(page.locator('#mmzh-root #status')).not.toContainText('載入');
  assert.match(await page.locator('#mmzh-root #status').textContent(),/完整|complete/i);
  assert.doesNotMatch(await page.locator('#mmzh-root #status').textContent(),/未完成|incomplete/i);
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
  await page.locator('#mmzh-root [data-lang="en"]').click();
  const captions=catalog.units.filter(u=>u.targets.length===1&&['#genres-relations','#supergenres-blueprint'].includes(u.targets[0].selector));
  assert.equal(captions.length,2);
  await expect.poll(()=>page.evaluate(units=>units.map(u=>document.querySelector(`${u.targets[0].selector} > label.image-label`)?.textContent),captions)).toEqual(captions.map(u=>u.plainText));
  await page.evaluate(units=>{
    window.qaCaptions=units.map(u=>{
      const parent=document.querySelector(u.targets[0].selector),label=parent.querySelector(':scope > label.image-label'),svg=parent.querySelector(':scope > svg');
      if(!svg||parent.querySelectorAll(':scope > svg').length!==1)throw new Error(`Original caption SVG missing: ${u.id}`);
      return {selector:u.targets[0].selector,parent,label,svg,children:[...parent.childNodes],originalLabelNodes:[...label.childNodes],originalLabelHTML:label.innerHTML,
        svgAttributes:[...svg.attributes].map(a=>[a.name,a.value]),labelAttributes:[...label.attributes].map(a=>[a.name,a.value])};
    });
  },captions);
  const labelSources=catalog.source.filter(s=>!uniqueBody.includes(s));
  await page.evaluate(sources=>{
    const keys=new Set(sources),norm=s=>s.replace(/\s+/g,' ').trim();
    window.qaRealLabels=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode,p=node.parentElement,key=norm(node.nodeValue);
      if(p&&!p.closest('#mmzh-root,[data-mmzh-original],[data-mmzh-chapter],script,style,noscript,iframe,textarea,#right-side-pane-songlist,.song-title,#people-list,#genres-relations .image-label,#supergenres-blueprint .image-label')&&keys.has(key))window.qaRealLabels.push({node,key,original:node.nodeValue});
    }
    window.qaAttributes=[];
    for(const node of document.querySelectorAll('[title],[placeholder],[aria-label],[data-bs-original-title],[data-bs-content],[data-live-search-placeholder]')){
      if(node.closest('#mmzh-root,[data-mmzh-original]'))continue;
      for(const name of ['title','placeholder','aria-label','data-bs-original-title','data-bs-content','data-live-search-placeholder']){
        const original=node.getAttribute(name),key=original&&norm(original);if(keys.has(key))window.qaAttributes.push({node,name,key,original});
      }
    }
    const fixture=document.createElement('div');fixture.id='qa-complete-label-fixture';fixture.hidden=true;
    for(const source of sources){const span=document.createElement('span');span.textContent=source;fixture.appendChild(span);}
    document.body.appendChild(fixture);
  },labelSources);
  for(const lang of ['zh-Hans','zh-Hant','en']){
    await page.locator(`#mmzh-root [data-lang="${lang}"]`).click();
    await expect.poll(()=>page.evaluate(({lang,sources,locale})=>{
      const mismatches=[],fixture=document.getElementById('qa-complete-label-fixture');
      [...fixture.children].forEach((n,i)=>{const expected=lang==='en'?sources[i]:locale[sources[i]];if(n.textContent!==expected)mismatches.push(`fixture ${i}`);});
      for(const r of window.qaRealLabels){if(!r.node.isConnected)continue;const expected=lang==='en'?r.original:r.original.replace(r.original.trim(),()=>locale[r.key]);if(r.node.nodeValue!==expected)mismatches.push(`real label ${r.key}`);}
      for(const r of window.qaAttributes){if(!r.node.isConnected)continue;const expected=lang==='en'?r.original:locale[r.key];if(r.node.getAttribute(r.name)!==expected)mismatches.push(`real attr ${r.key}`);}
      return mismatches;
    },{lang,sources:labelSources,locale:locales[lang]??{}})).toEqual([]);
    const liveCounts=await page.evaluate(()=>({textNodes:window.qaRealLabels.filter(r=>r.node.isConnected).length,attributes:window.qaAttributes.filter(r=>r.node.isConnected).length}));
    labelChecks.push({device,language:lang,independentLabelFixture:labelSources.length,actualSourceDom:liveCounts});
    const captionExpected=captions.map(u=>lang==='en'?u.plainText:stripChapterMarkers(locales[lang][u.source]));
    await expect.poll(()=>page.evaluate(({lang,expected})=>window.qaCaptions.flatMap((r,i)=>{
      const mismatches=[],parent=document.querySelector(r.selector),label=parent?.querySelector(':scope > label.image-label'),svg=parent?.querySelector(':scope > svg');
      if(parent!==r.parent||label!==r.label||svg!==r.svg)mismatches.push(`${r.selector}: original node identity changed`);
      if([...parent.childNodes].length!==r.children.length||r.children.some((n,j)=>parent.childNodes[j]!==n))mismatches.push(`${r.selector}: original child order changed`);
      if(label.textContent!==expected[i])mismatches.push(`${r.selector}: caption text differs`);
      if(JSON.stringify([...svg.attributes].map(a=>[a.name,a.value]))!==JSON.stringify(r.svgAttributes))mismatches.push(`${r.selector}: SVG attributes changed`);
      if(JSON.stringify([...label.attributes].map(a=>[a.name,a.value]))!==JSON.stringify(r.labelAttributes))mismatches.push(`${r.selector}: label attributes changed`);
      if(lang==='en'&&(label.innerHTML!==r.originalLabelHTML||label.childNodes.length!==r.originalLabelNodes.length||r.originalLabelNodes.some((n,j)=>label.childNodes[j]!==n)))mismatches.push(`${r.selector}: original English nodes not restored`);
      return mismatches;
    }),{lang,expected:captionExpected})).toEqual([]);
    captionChecks.push({device,language:lang,captions:captions.length,exactText:true,originalSvgAndLabelIdentity:true,attributesAndPositionPreserved:true,...(lang==='en'?{originalEnglishNodesRestored:true}:{})});
    console.log(JSON.stringify({device,language:lang,stage:'all-labels-and-actual-source-dom-verified',...liveCounts}));
  }
  await page.evaluate(()=>document.getElementById('qa-complete-label-fixture').remove());
  const consent=page.locator('#privacy-policy-accept-btn');if(await consent.isVisible())await consent.click();
  await page.locator('#genres-navigate-button:not([disabled])').waitFor({state:'attached'});
  const body=catalog.units.filter(u=>u.kind==='genre');
  const sample=body.filter((u,i)=>i%25===0||['alt02','met','inl','inl09','inr01','inr11'].includes(u.genreId));
  for(const lang of ['zh-Hans','zh-Hant','en']){
   const selected=body;
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
  await page.locator('#mmzh-root #open-search').click();await page.locator('#mmzh-root #search').fill('噪音搖滾');
  await expect(page.locator('#mmzh-root #results button').first()).toBeVisible();await page.locator('#mmzh-root #results button').first().click();
  await expect(page.locator('#right-side-pane-genre-description')).toHaveAttribute('data-mmzh-chapter','genre:alt02');
  const fresh=body.find(u=>u.genreId==='inl'&&locales['zh-Hant'][u.source]);
  if(fresh){await navigate(page,fresh.genreId);await expect(page.locator('#supergenre-side-pane-genre-description')).toHaveAttribute('data-mmzh-chapter',fresh.id);}
  await page.screenshot({path:resolve(run,`preview-${device}.png`)});
  await context.close();
 }));
 assert.deepEqual(errors,[]);assert.ok(!requests.some(url=>/api\.deepseek\.com/.test(url)));
 assert.deepEqual(await treeHashes(resolve(run,'workspace/dist')),builtHashes,'Built files changed during browser verification.');
 const evidence={passed:true,verifiedAt:new Date().toISOString(),bodyCompleted:562,bodyTotal:562,labelsCompleted:1338,totalCompleted:1900,
  genreLanguageChecks:checks.length,checks,staticChecks,englishExactRestore:true,inlineLinkAttributesPreserved:true,
  originalNavigation:true,sourceSvgPreserved:true,mapZoom:{desktop:'original button',mobile:'wheel'},
  fullSourceCoverage:true,formalCompleteLabelVisible:true,labelChecks,captionChecks,buildFileHashes:builtHashes,
  browserScriptHash:sha256(await readFile(new URL(import.meta.url))),externalNetworkBlocked:true,deepseekBrowserRequests:0,
  inheritedBaselineLimitations:['At 390px the original reader toolbar covers the original zoom-in button; original UI is retained and wheel zoom was verified.'],errors};
 await writeFile(resolve(run,'browser-verification.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:true,bodyCompleted:buildEvidence.bodyCompleted,genreLanguageChecks:checks.length,staticMappings:staticChecks.reduce((n,x)=>n+x.mappings,0),errors:0}));
}finally{await browser?.close();await new Promise(done=>site.close(done));}
