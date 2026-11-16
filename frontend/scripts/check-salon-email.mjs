import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,extname} from 'node:path';
import http from 'node:http';
import {launch} from './lib/browser.mjs';
import {fetchStubSource,sessionSeedSource,bundleSupabaseUrl} from './lib/fixtures.mjs';
const dist=new URL('../dist',import.meta.url).pathname;
const server=http.createServer((req,res)=>{
 let f=join(dist,req.url.split('?')[0]);if(!existsSync(f)||!extname(f))f=join(dist,'index.html');
 res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(f)]||'application/octet-stream');res.end(readFileSync(f));
}).listen(0);
const browser=await launch(),origin=`http://127.0.0.1:${server.address().port}`;
try {
 for(const mode of ['ready','pending','unavailable','error','paused']) {
  const context=await browser.newContext({viewport:{width:mode==='ready'?320:390,height:844}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(fetchStubSource());await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(mode=>{
   const base=window.fetch;window.__mailMutations=[];
   window.fetch=async(input,options={})=>{
    const path=String(input).split('/api/email/')[1];if(!path)return base(input,options);
    if(options.method==='POST')window.__mailMutations.push(path);
    if(path==='salon/status')return Response.json(mode==='error'?{error:'Your Florrie email could not be checked.'}:{available:mode!=='unavailable',address:'fictional-salon@inbox.florrie.ai',status:mode==='paused'?'paused':'active',pending:mode==='pending'?2:0},{status:mode==='error'?503:200});
    return Response.json({connection:null,providers:[{id:'google',available:false},{id:'microsoft',available:false}]});
   };
  },mode);
  const page=await context.newPage();await page.goto(`${origin}/connections`);
  await page.getByRole('heading',{name:'Your salon email',exact:true}).waitFor();
  if(mode==='error') {await page.getByRole('alert').filter({hasText:'could not be checked'}).waitFor();await page.getByRole('button',{name:'Try again',exact:true}).click();}
  else if(mode==='unavailable')await page.getByText('We’re preparing Florrie email',{exact:false}).waitFor();
  else {
   assert.equal(await page.getByLabel('Your address',{exact:true}).inputValue(),'fictional-salon@inbox.florrie.ai');
   assert.equal(await page.getByRole('link',{name:'Open your Inbox',exact:false}).getAttribute('href'),'/inbox');
   if(mode==='pending')await page.getByText('2 incoming emails need checking.',{exact:false}).waitFor();
   if(mode==='paused')await page.getByText('Your address is paused.',{exact:false}).waitFor();
  }
  assert.equal(await page.getByRole('button',{name:'Connect Gmail',exact:true}).isVisible(),false,'existing mailbox stays optional');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'fits mobile');
  assert.deepEqual(await page.evaluate(()=>window.__mailMutations),[],'viewing setup sends no emails');
  if(mode==='ready'&&process.env.SALON_EMAIL_SCREENSHOT)await page.screenshot({path:process.env.SALON_EMAIL_SCREENSHOT,fullPage:true});
  console.log('PASS salon email: '+mode);await context.close();
 }
}finally{await browser.close();server.close();}
