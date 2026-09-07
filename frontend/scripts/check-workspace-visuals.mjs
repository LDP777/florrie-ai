// Populated mobile/desktop checks. All data and writes remain synthetic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req,res)=>{
 let file=join(dist,(req.url||'/').split('?')[0]);
 if(!existsSync(file)||!extname(file)) file=join(dist,'index.html');
 res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');
 try{res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}
}).listen(0);
const browser=await launch();
const theme=readFileSync(new URL('../src/lib/theme.jsx',import.meta.url),'utf8');
const darkStart=theme.indexOf('const darkTokens = {');
const darkTokens=Object.fromEntries([...theme.slice(darkStart,theme.indexOf('\n};',darkStart)).matchAll(/'(--[\w-]+)':\s*'([^']*)'/g)].map(m=>[m[1],m[2]]));
const output=process.env.VISUAL_OUTPUT_DIR;
if(output) mkdirSync(output,{recursive:true});
try {
 for(const width of [320,390,1024]) {
  const ctx=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await ctx.addInitScript(fetchStubSource());await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(()=>{
   const base=window.fetch;window.__writes=0;
   const json=data=>Promise.resolve(new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}));
   window.fetch=(input,opts={})=>{
    const url=String(input);
    if(url.includes('/api/inbox/thread/'))return json({client:{id:'visual',first_name:'Grace',last_name:'Harris',has_phone:true,has_email:true,has_whatsapp:true,messaging_autonomy:null},meta:{visits:4,last_visit_at:'2026-08-07T13:00:00Z',next_appointment_at:'2026-09-19T13:00:00Z'},default_channel:'whatsapp',drafts:[],messages:[
     {id:'m1',direction:'inbound',body:'Hey! Could I book my usual brows for next week?',channel:'whatsapp',created_at:new Date(Date.now()-3600000).toISOString()},
     {id:'m2',direction:'outbound',message_type:'auto_reply',body:'Of course. Saturday at 1pm is available for your Signature brows. Would that work for you?',channel:'whatsapp',created_at:new Date(Date.now()-1800000).toISOString()},
     {id:'m3',direction:'inbound',body:'That’s perfect, thank you! See you then x',channel:'whatsapp',created_at:new Date().toISOString()}
    ]});
    if(url.includes('/api/inbox/suggestions/'))return json({suggestions:[{id:'s1',label:'Confirm details',text:'Your appointment is Saturday at 1pm.'},{id:'s2',label:'Share booking link',text:'Here is your booking link.'}]});
    if(url.includes('/api/inbox'))return json({threads:[],counts:{}});
    if(/\/api\/content(?:\?|$)/.test(url))return json({posts:[{id:'p1',post_type:'before_after',status:'draft',caption:'A softer shape, a little definition. Signature brows from the studio today.',created_at:new Date().toISOString()}]});
    if(url.includes('/api/voice/command')) {window.__writes++;return json({reply:'Your next appointment is at 1pm.'});}
    return base(input,opts);
   };
  });
  const page=await ctx.newPage();
  for(const route of ['voice','content','inbox?client=visual']) {
   await page.goto(`http://127.0.0.1:${server.address().port}/${route}`);
   const kind=route.split('?')[0];
   await page.locator(kind==='voice'?'.fl-voice-starts':kind==='content'?'.fl-content-heading':'.fl-chat-settings').waitFor();
   await page.evaluate(()=>document.fonts.ready);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${kind} overflows at ${width}`);
   if(output)await page.screenshot({path:join(output,`${kind}-${width}.png`)});
   if(kind==='voice') {
    assert.ok(await page.locator('.fl-voice-emblem').evaluate(el=>el.getBoundingClientRect().top>=0),'Voice welcome stays in view');
    await page.getByRole('button',{name:/^My day/}).click();
    assert.equal(await page.getByRole('textbox',{name:'Message Florrie'}).inputValue(),'What does today look like?');
    assert.equal(await page.evaluate(()=>window.__writes),0);
   }
   if(kind==='inbox') {
    const lastMessage=page.getByText('That’s perfect, thank you! See you then x',{exact:true});
    await page.locator('.fl-chat-history').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const lastBottom=await lastMessage.evaluate(el=>el.getBoundingClientRect().bottom);
    const historyBottom=await page.locator('.fl-chat-history').evaluate(el=>el.getBoundingClientRect().bottom);
    assert.ok(lastBottom<=historyBottom,'Latest message can be read above composer');
    const composerBottom=await page.locator('.fl-chat-composer').evaluate(el=>el.getBoundingClientRect().bottom);
    const navTop=await page.getByRole('navigation').filter({has:page.getByText('Today',{exact:true})}).evaluate(el=>el.getBoundingClientRect().top);
    assert.ok(composerBottom<=navTop,`Composer ${composerBottom} covers nav ${navTop}`);
    assert.equal(await page.locator('.fl-chat-settings').getAttribute('open'),null);
    await page.getByRole('textbox',{name:'Reply via WhatsApp'}).fill('Keep my draft');
    await page.getByRole('tab',{name:'Email',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Reply via Email'}).inputValue(),'Keep my draft');
    await page.locator('.fl-chat-settings summary').click();
    await page.getByRole('tab',{name:'Me',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__writes),0);
   }
   if(output && width===390) {
    await page.evaluate(tokens=>Object.entries(tokens).forEach(([k,v])=>document.documentElement.style.setProperty(k,v)),darkTokens);
    await page.screenshot({path:join(output,`${kind}-dark.png`)});
   }
   console.log(`✓ ${kind} ${width}px: populated layout and controls`);
  }
  await ctx.close();
 }
} finally {await browser.close();server.close();}
