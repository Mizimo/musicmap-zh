import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../server.mjs';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {parseChapterTranslation,stripChapterMarkers} from '../public/chapter-renderer.js';
const run=resolve(process.argv[2]??'artifacts/full-site/2026-10-15-complete');
const site=process.argv[3]?null:createApp({directory:join(run,'workspace/dist')});
if(site)await new Promise(done=>site.listen(0,'127.0.0.1',done));
const origin=process.argv[3]?new URL(process.argv[3]).origin:`http://127.0.0.1:${site.address().port}`;
const catalog=JSON.parse(await readFile(join(run,'workspace/.cache/source/units.json')));
const traditional=JSON.parse(await readFile(join(run,'workspace/dist/_zh/locales/zh-Hant.json')));
const anchorUnit=catalog.units.find(u=>Object.values(u.markers).some(m=>m.attributes.id==='privacy-policy-link'));
const anchorId=Object.keys(anchorUnit.markers).find(id=>anchorUnit.markers[id].attributes.id==='privacy-policy-link');
const anchorAst=parseChapterTranslation(anchorUnit.source,traditional[anchorUnit.source]).children.flatMap(p=>p.children).find(n=>n.id===anchorId);
assert.ok(anchorAst.children.every(n=>n.type==='text'));const anchorText=anchorAst.children.map(n=>n.value).join('');
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[];
page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
try{
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin,{waitUntil:'networkidle'});await expect(page.locator('#mmzh-root #status')).not.toContainText('載入');
 await page.evaluate(()=>window.originalPrivacyAnchor=document.getElementById('privacy-policy-link'));
 await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();
 await expect(page.locator('#mmzh-root #status')).toContainText(/完整|complete/i);
 await expect.poll(()=>page.evaluate(()=>window.originalPrivacyAnchor===document.getElementById('privacy-policy-link'))).toBe(true);
 await expect(page.locator('#privacy-policy-link')).toHaveText(anchorText);
 await page.locator('#privacy-policy-link').click();await expect(page.locator('#privacy-policy-side-pane')).toHaveClass(/left-side-pane-open/);
 await page.locator('#privacy-policy-side-pane .left-side-pane-close-button').click();await expect(page.locator('#privacy-policy-side-pane')).not.toHaveClass(/left-side-pane-open/);
 console.log(JSON.stringify({stage:'translated-source-link-open-close-passed'}));
 const consent=page.locator('#privacy-policy-accept-btn');if(await consent.isVisible())await consent.click();
 await page.locator('#genres-navigate-button:not([disabled])').waitFor({state:'attached'});
 console.log(JSON.stringify({stage:'original-map-ready'}));
 await page.locator('#musicmap-button').click();
 await page.locator('#mmzh-root [data-lang="zh-Hant"]').click();await page.locator('#mmzh-root #open-search').click();
 await page.locator('#mmzh-root #search').fill('噪音搖滾');const result=page.locator('#mmzh-root #results button').filter({hasText:/Noise Rock/i}).first();
 await expect(result).toBeVisible();await result.click();
 const pane=page.locator('#right-side-pane-genre-description');await expect(pane).toHaveAttribute('data-mmzh-chapter','genre:alt02');
 const searchUnit=catalog.units.find(u=>u.id==='genre:alt02');
 assert.equal(searchUnit.layout.length,1,'Noise Rock is a single paragraph; textContent can be compared byte for byte.');
 await expect.poll(()=>pane.textContent()).toBe(stripChapterMarkers(traditional[searchUnit.source]));
 const exactTranslatedSearchBody=true;
 assert.deepEqual(errors,[]);assert.ok(!requests.some(url=>/api\.deepseek\.com/.test(url)));
 const evidence={passed:true,verifiedAt:new Date().toISOString(),origin,chineseSearch:'噪音搖滾',searchTarget:'genre:alt02',
  exactTranslatedSearchBody,translatedAnchorNodePreserved:true,translatedAnchorNativeHandlerVerified:true,anchorTarget:'privacy-policy-side-pane',
  genreBodyAnchors:catalog.units.filter(u=>u.kind==='genre').flatMap(u=>Object.values(u.markers)).filter(m=>m.tag==='a').length,
  deepseekBrowserRequests:0,externalNetworkBlocked:true,errors};
 await writeFile(join(run,origin.startsWith('https:')?'tailnet-navigation-verification.json':'preview-navigation-verification.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await browser.close();if(site)await new Promise(done=>site.close(done));}
