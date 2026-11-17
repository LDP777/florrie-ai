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
   const base=window.fetch;window.__writes=0;localStorage.setItem('florrie_recent_pages',JSON.stringify([{path:'/clients'},{path:'/hours'}]));
   const json=data=>Promise.resolve(new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}));
   window.fetch=(input,opts={})=>{
    const url=String(input);
    if(url.includes('/api/')&&!['GET','HEAD'].includes((opts.method||'GET').toUpperCase()))window.__writes++;
    if(url.includes('/api/inbox/thread/'))return json({client:{id:'visual',first_name:'Grace',last_name:'Harris',has_phone:true,has_email:true,has_whatsapp:true,messaging_autonomy:null},meta:{visits:4,last_visit_at:'2026-08-07T13:00:00Z',next_appointment_at:'2026-09-19T13:00:00Z'},default_channel:'whatsapp',drafts:[],messages:[
     {id:'m1',direction:'inbound',body:'Hey! Could I book my usual brows for next week?',channel:'whatsapp',created_at:new Date(Date.now()-3600000).toISOString()},
     {id:'m2',direction:'outbound',message_type:'auto_reply',body:'Of course. Saturday at 1pm is available for your Signature brows. Would that work for you?',channel:'whatsapp',created_at:new Date(Date.now()-1800000).toISOString()},
     {id:'m3',direction:'inbound',body:'That’s perfect, thank you! See you then x',channel:'whatsapp',created_at:new Date().toISOString()}
    ]});
    if(url.includes('/api/inbox/suggestions/'))return json({suggestions:[{id:'s1',label:'Confirm details',text:'Your appointment is Saturday at 1pm.'},{id:'s2',label:'Share booking link',text:'Here is your booking link.'}]});
    if(url.includes('/api/inbox'))return json({threads:[
      {client_id:'visual',client_first_name:'Grace',client_last_name:'Harris',space:'clients',segment:'needs',last_channel:'whatsapp',last_message_type:'inbound',last_message_direction:'inbound',last_message_preview:'Could I book my usual brows?',last_message_at:new Date().toISOString(),needs_attention:true,unread_count:1},
      {client_id:'regular',client_first_name:'Sam',client_last_name:'Green',space:'clients',segment:'client',last_channel:'sms',last_message_type:'you',last_message_direction:'outbound',last_message_preview:'See you on Saturday.',last_message_at:new Date().toISOString(),unread_count:0},
      {client_id:'lead',client_first_name:'Maya',client_last_name:'Bell',instagram_username:'maya_demo',space:'instagram',segment:'new',is_social_lead:true,last_channel:'instagram',last_message_type:'inbound',last_message_direction:'inbound',last_message_preview:'What brow treatments do you offer?',last_message_at:new Date().toISOString(),unread_count:1}
    ],counts:{}});
    if(/\/api\/content(?:\?|$)/.test(url))return json({posts:[{id:'p1',post_type:'before_after',status:'draft',caption:'A softer shape, a little definition. Signature brows from the studio today.',created_at:new Date().toISOString()}]});
    if(url.includes('/api/voice/command')) {return json({reply:'Your next appointment is at 1pm.'});}
    return base(input,opts);
   };
  });
  const page=await ctx.newPage();
  for(const route of ['voice','content','inbox?client=visual','inbox','more']) {
   await page.goto(`http://127.0.0.1:${server.address().port}/${route}`);
   const kind=route==='inbox'?'inbox-list':route.split('?')[0];
   await page.locator(kind==='voice'?'.fl-command-stack':kind==='content'?'.fl-content-heading':kind==='more'?'.more-shortcut-grid':kind==='inbox-list'?'.inbox-row':'.fl-chat-settings').first().waitFor();
   if(kind==='content') {
    await page.getByRole('button',{name:'Your posts',exact:true}).click();
    const savedPost=page.locator('#content-post-p1');
    await savedPost.waitFor();
    assert.equal(await page.getByRole('button',{name:'Your posts',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('button',{name:'Create a post',exact:true}).count(),1,'Content has one clear creation action');
    assert.equal(await savedPost.getByRole('button',{name:'Review post',exact:true}).count(),1);
    assert.equal(await savedPost.getByRole('button',{name:'Edit',exact:true}).count(),0,'Draft actions stay collapsed until review');
    assert.equal(await page.locator('.fl-content-home').count(),0,'Optional ideas do not displace the saved posts');
   }
   await page.evaluate(()=>document.fonts.ready);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${kind} overflows at ${width}`);
   if(output)await page.screenshot({path:join(output,`${kind}-${width}.png`)});
   if(kind==='voice') {
    assert.ok(await page.locator('.fl-voice-emblem').evaluate(el=>el.getBoundingClientRect().top>=0),'Voice welcome stays in view');
    await page.getByRole('button',{name:'More ways to ask',exact:true}).click();
    await page.getByRole('button',{name:'Clients',exact:true}).click();
    await page.getByRole('button',{name:/^Find a client/}).click();
    assert.equal(await page.getByRole('textbox',{name:'Message Florrie'}).inputValue(),'Tell me about ');
    assert.equal(await page.evaluate(()=>window.__writes),0);
   }
   if(kind==='inbox') {
    assert.equal(await page.locator('.fl-chat-visit').innerText(),'Next: Sat 19 Sept, 13:00');
    const visitFits=await page.locator('.fl-chat-visit').evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1);
    assert.ok(visitFits,'The next visit is readable without truncation');
    assert.ok(await page.locator('.fl-chat-history').evaluate(el=>el.getBoundingClientRect().height)>=290,'Conversation retains room to read on a small phone');
    assert.equal(await page.getByRole('button',{name:'View profile',exact:true}).count(),1);
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
    await page.getByText('You send email replies',{exact:true}).waitFor();
    assert.equal(await page.locator('.fl-chat-settings summary').count(),0,'email must not offer automatic reply controls');
    assert.equal(await page.getByRole('link',{name:'Email connection & draft settings',exact:true}).getAttribute('href'),'/connections');
    await page.getByRole('tab',{name:'WhatsApp',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Reply via WhatsApp'}).inputValue(),'Keep my draft');
    await page.locator('.fl-chat-settings summary').click();
    await page.getByRole('tab',{name:'Me',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__writes),0);
   }
   if(kind==='inbox-list') {
    const activeFilter=page.getByRole('group',{name:'Filter conversations'}).getByRole('button',{name:/^All/});
    assert.equal(await activeFilter.getAttribute('aria-pressed'),'true');
    assert.ok(await activeFilter.evaluate(el=>el.getBoundingClientRect().right<=innerWidth),'The selected All filter is visible without scrolling');
    const search=page.getByRole('searchbox',{name:'Search conversations'});
    await search.fill('Grace');
    assert.equal(await page.locator('.inbox-row').count(),1);
    await page.locator('.inbox-row').click();
    await page.getByRole('textbox',{name:'Reply via WhatsApp'}).waitFor();
    if(width<768) {
      await page.getByRole('button',{name:'Back to inbox'}).click();
      assert.equal(await search.inputValue(),'Grace','Returning to the list preserves the search');
    } else {
      assert.equal(await search.inputValue(),'Grace');
    }
    await search.fill('');
    await page.getByRole('tab',{name:/^Instagram/}).click();
    await page.locator('.inbox-row').filter({hasText:'Maya Bell'}).waitFor();
    await search.fill('maya_demo');
    assert.equal(await page.locator('.inbox-row').count(),1,'Instagram handles remain searchable');
    assert.equal(await page.evaluate(()=>window.__writes),0,'Browsing and reply controls do not send or change preferences');
   }
   if(kind==='more') {
    assert.equal(await page.locator('.more-shortcut').count(),6);
    assert.equal(await page.locator('.more-recent-link[href="/clients"]').count(),0,'Recent pages do not duplicate a shortcut');
    assert.equal(await page.locator('.more-recent-link[href="/hours"]').count(),1,'Other recent pages stay available');
    const search=page.getByRole('searchbox',{name:'Search More tools'});
    await search.fill('consent');
    await page.locator('.more-tool[href="/photo-consent"]').waitFor();
    await search.fill('rota');
    await page.locator('.more-tool[href="/rota"]').waitFor();
    await search.press('Escape');
    assert.equal(await search.inputValue(),'');
    await page.getByRole('button',{name:'Expand all',exact:true}).click();
    assert.ok(await page.locator('.more-tool:visible').count()>30,'All tools remain reachable');
    await page.getByRole('button',{name:'Collapse all',exact:true}).click();
    assert.equal(await page.locator('.more-tool:visible').count(),0);
    await page.goto(`http://127.0.0.1:${server.address().port}/more?group=team`);
    await page.locator('.more-tool[href="/rota"]').waitFor();
    assert.equal(await page.locator('#more-heading-team button').getAttribute('aria-expanded'),'true','Group links open the relevant tools');
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
