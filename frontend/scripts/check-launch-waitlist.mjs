import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { launch } from './lib/browser.mjs';
import { waitlistWelcomeEmail } from '../../backend/src/templates/waitlist-welcome.js';
const dist=new URL('../dist/',import.meta.url).pathname;
const output=process.env.WAITLIST_SCREENSHOT_DIR;
if(output)mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
 if(req.url==='/welcome-preview.html'){res.setHeader('content-type','text/html');return res.end(waitlistWelcomeEmail('11111111-2222-3333-4444-555555555555').html);}
 let f=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(f)||!extname(f))f=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'})[extname(f)]||'application/octet-stream');try{res.end(readFileSync(f));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await launch();let groups=0;
async function check(width, mode='success'){
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,javaScriptEnabled:mode!=='nojs'});
 let writes=[];let fail=mode==='recovery';
 await context.route('**/*',async r=>{
  const u=new URL(r.request().url());
  if(u.pathname==='/api/waitlist/config')return r.fulfill({json:{required:false,siteKey:''}});
  if(u.pathname==='/api/waitlist'&&r.request().method()==='POST'){
   writes.push(r.request().postDataJSON());
   if(fail){fail=false;return r.fulfill({status:503,json:{error:'We could not confirm your signup. Please try again.'}});}
   return r.fulfill({json:{success:true,message:'Thanks'}});
  }
  if(u.origin===origin&&r.request().method()==='GET')return r.continue();
  return r.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin+'/landing.html?utm_source=instagram&utm_medium=social&utm_campaign=ellie_first_post');
  const form=page.getByRole('form',{name:'Join the Florrie waitlist'});
  if(mode==='nojs'){
   assert.match(await page.locator('noscript').innerText(),/levi@florrie.ai/);
   assert.equal(writes.length,0);
  }else{
   await form.getByRole('button',{name:'Join the waitlist',exact:true}).waitFor();
   await page.locator('#waitlist-email').fill('test@example.com');
   await form.getByRole('button',{name:'Join the waitlist',exact:true}).click();
   assert.equal(writes.length,0,'unchecked consent blocks submission');
   await form.getByRole('checkbox').check();
   await form.getByRole('button',{name:'Join the waitlist',exact:true}).click();
   if(mode==='recovery'){
    await page.getByRole('alert').filter({hasText:'could not confirm'}).waitFor();
    assert.equal(await page.locator('#waitlist-email').inputValue(),'test@example.com');
    assert.equal(await form.getByRole('checkbox').isChecked(),true);
    await form.getByRole('button',{name:'Join the waitlist',exact:true}).click();
   }
   await page.getByRole('region',{name:'A little less admin. A little more you.'}).waitFor();
   assert.equal(await form.isVisible(),false);
   assert.equal(await page.locator('#waitlist-success-email').innerText(),'test@example.com');
   assert.equal(await page.locator('#waitlist-success').evaluate(el=>el===document.activeElement),true);
   assert.equal(writes.length,mode==='recovery'?2:1);
   assert.equal(writes.at(-1).marketingConsent,true);
   assert.equal(writes.at(-1).attribution.utm_campaign,'ellie_first_post');
   assert.equal(await page.locator('#waitlist-success').getByRole('link',{name:'Take a look at Florrie'}).getAttribute('href'),'#demo');
   assert.deepEqual(errors,[]);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(output&&mode==='success'){await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#waitlist').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,`waitlist-${width}.png`),animations:'disabled'});}
  groups++;console.log(`✓ Waitlist ${width}px: ${mode}`);
 }finally{await context.close();}
}
async function checkRoot() {
 const context=await browser.newContext();
 await context.route('**/*', r => new URL(r.request().url()).origin===origin ? r.continue() : r.abort());
 const page=await context.newPage();
 try {
  await page.goto(origin+'/?utm_source=instagram&utm_campaign=ellie_first_post&private_value=discard#waitlist');
  await page.waitForURL('**/landing.html?**',{timeout:20000});
  const u=new URL(page.url());assert.equal(u.searchParams.get('utm_source'),'instagram');assert.equal(u.searchParams.get('utm_campaign'),'ellie_first_post');assert.equal(u.searchParams.has('private_value'),false);assert.equal(u.hash,'#waitlist');
  groups++;console.log('✓ Anonymous homepage keeps campaign tags and the waitlist anchor, drops unrelated query values');
 } finally {await context.close();}
}
async function checkEmail(width) {
 const context=await browser.newContext({viewport:{width,height:900}});
 await context.route('**/*',async r=>{
   const u=new URL(r.request().url());
   if(u.origin===origin)return r.continue();
   const asset=join(dist,u.pathname);
   if(u.hostname==='florrie.ai'&&existsSync(asset)&&['.png','.woff2'].includes(extname(asset)))return r.fulfill({body:readFileSync(asset),contentType:extname(asset)==='.png'?'image/png':'font/woff2'});
   return r.abort();
 });
 const page=await context.newPage();
 try {
   await page.goto(origin+'/welcome-preview.html');await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'email fits phone');
   assert.match(await page.getByRole('link',{name:'Unsubscribe',exact:true}).getAttribute('href'),/\/api\/waitlist\/unsubscribe\?token=/);
   assert.equal(await page.getByRole('link',{name:/Take a look at Florrie/}).getAttribute('href'),'https://florrie.ai/landing.html#demo');
   assert.equal(await page.getByRole('img',{name:'Florrie flower'}).evaluate(el=>el.complete&&el.naturalWidth>0),true);
   if(output)await page.screenshot({path:join(output,`welcome-email-${width}.png`),fullPage:true});
   groups++;console.log(`✓ Welcome email ${width}px: brand image, links and layout`);
 }finally{await context.close();}
}
try{await checkRoot();await check(320);await check(390);await check(1440);await check(390,'recovery');await check(390,'nojs');await checkEmail(320);await checkEmail(390);await checkEmail(600);console.log(`${groups} launch waitlist browser groups passed.`);}finally{await browser.close();await new Promise(r=>server.close(r));}
