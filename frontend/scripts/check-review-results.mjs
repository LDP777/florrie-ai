// Real app pages, fictional salon, no Google writes or customer bookings.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import http from 'node:http';
import {launch} from './lib/browser.mjs';
import {fetchStubSource,sessionSeedSource,bundleSupabaseUrl} from './lib/fixtures.mjs';
const dist=new URL('../dist',import.meta.url).pathname;
const server=http.createServer((req,res)=>{let file=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(file)||!extname(file))file=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await launch();const output=process.env.VISUAL_OUTPUT_DIR;if(output)mkdirSync(output,{recursive:true});
try {for(const width of [320,390,1024]){
 const ctx=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
 await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await ctx.addInitScript(fetchStubSource());await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
 await ctx.addInitScript(()=>{
  const base=window.fetch,json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
  const post={id:'11111111-1111-4111-8111-111111111111',caption:'A detail from the studio',status:'posted',post_type:'general',posted_at:new Date().toISOString()};
  window.__reviewTest={sends:[],failReply:true,resultsFail:false,links:0};
  window.fetch=(input,options={})=>{
   const url=String(input),t=window.__reviewTest;
   if(url.includes('/rest/v1/reviews?')){
    const state=sessionStorage.getItem('test-feedback-read');
    if(state==='failed')return json({message:'Synthetic saved-feedback failure'},503);
    if(state==='stalled')return new Promise(resolve=>{t.releaseFeedback=()=>resolve(new Response('[]',{headers:{'content-type':'application/json'}}));});
   }
   if(url.includes('/api/google-reviews/status')){
    const state=sessionStorage.getItem('test-google-availability');
    if(state==='disabled')return json({available:false,connected:false});
    if(state==='available')return json({available:true,connected:false});
    if(state==='failed')return json({error:'Could not check the Google connection.'},503);
    return json({available:true,connected:true,location:{name:'accounts/1/locations/2',title:'Fictional Brow Studio'}});
   }
   if(url.includes('/api/google-reviews/reviews/r1/draft'))return json({draft:'Thank you for your kind words about the studio.',fingerprint:'current'});
   if(url.includes('/api/google-reviews/reviews/r1/reply')){t.sends.push(JSON.parse(options.body));return t.failReply?json({error:'The reply result is uncertain. Reload Google reviews before trying again.'},503):json({reply:{comment:JSON.parse(options.body).text}});}
   if(url.includes('/api/google-reviews/reviews'))return json({fetched_at:new Date().toISOString(),reviews:[{name:'accounts/1/locations/2/reviews/r1',reviewId:'r1',starRating:'FIVE',comment:'A thoughtful appointment in a welcoming studio.',reviewer:{displayName:'Fictional reviewer'},fingerprint:'current'}]});
   if(url.includes('/api/content/results'))return t.resultsFail?json({error:'Booking results could not be loaded. Try again.'},503):json({days:90,explanation:'Bookings made through these links in the last 90 days. Other bookings and social views are not tracked. Booking value is not money collected.',campaigns:[{campaign_id:'c1',post_id:post.id,caption:post.caption,token:'a'.repeat(32),confirmed:2,pending:1,cancelled:1,booking_value_cents:6500,url:'https://florrie.test/book/fictional?fl_content='+ 'a'.repeat(32)}]});
   if(url.includes('/booking-link')){t.links++;return json({url:'https://florrie.test/book/fictional?fl_content='+ 'a'.repeat(32)});}
   if(/\/api\/content(?:\?|$)/.test(url))return json({posts:[post]});
   if(url.includes('/api/content/streams'))return json({streams:[]});
   if(url.includes('/api/instagram/status'))return json({connected:true,token_valid:true});
   return base(input,options);
  };
 });
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(width===390){
  await page.goto(`http://127.0.0.1:${server.address().port}/integrations`);
  await page.getByText('Google Reviews',{exact:true}).click();
  await page.getByText('In Reviews',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Google Reviews →',exact:true}).count(),0,'the directory does not claim Google is ready to connect');
  await page.evaluate(()=>sessionStorage.setItem('test-google-availability','disabled'));
  await page.getByRole('button',{name:'Open Reviews',exact:true}).click();
  await page.waitForURL('**/reviews');
  await page.getByText('Google imports and replies are awaiting connection setup.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).count(),0,'provider setup must finish before offering OAuth');
  assert.ok(await page.getByRole('button',{name:'Save review link',exact:true}).isEnabled(),'review-link setup remains usable while imports are disabled');
  await page.getByRole('button',{name:'Auto-ask',exact:true}).click();
  assert.equal(await page.getByText('Review imports are not available yet.',{exact:false}).count(),0,'static settings copy defers to the live connection status');
  await page.evaluate(()=>sessionStorage.setItem('test-google-availability','available'));
  await page.reload();
  await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).waitFor();
  assert.equal(await page.getByText('Google imports and replies are awaiting connection setup.',{exact:false}).count(),0);
  await page.evaluate(()=>sessionStorage.setItem('test-google-availability','failed'));
  await page.reload();
  await page.getByRole('alert').filter({hasText:'Could not check the Google connection.'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).count(),0,'an unknown connection must not be labelled available');
  assert.ok(await page.getByRole('button',{name:'Save review link',exact:true}).isEnabled());
  await page.evaluate(()=>sessionStorage.removeItem('test-google-availability'));
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByText('Fictional reviewer',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).count(),0,'a connected salon sees its reviews instead of a first-time connection prompt');
  assert.equal(await page.getByText('Google ratings and replies are managed in Google for now.',{exact:false}).count(),0);
  assert.deepEqual(await page.evaluate(()=>window.__reviewTest.sends),[],'navigation and status recovery never publish a reply');
  await page.evaluate(()=>sessionStorage.setItem('test-feedback-read','failed'));await page.reload();
  await page.getByText('Fictional reviewer',{exact:true}).waitFor();
  await page.getByText('Could not load feedback. Try again.',{exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'Save review link',exact:true}).isEnabled(),'failed saved-feedback storage does not block Google setup');
  await page.evaluate(()=>sessionStorage.removeItem('test-feedback-read'));
  await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByText('No reviews yet',{exact:true}).waitFor();
  assert.equal(await page.getByText('Fictional reviewer',{exact:true}).count(),1);
  await page.evaluate(()=>sessionStorage.setItem('test-feedback-read','stalled'));await page.reload();
  await page.getByText('Fictional reviewer',{exact:true}).waitFor();await page.getByText('Loading saved feedback…',{exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'Save review link',exact:true}).isEnabled(),'slow saved-feedback storage does not block Google setup');
  await page.evaluate(()=>{sessionStorage.removeItem('test-feedback-read');window.__reviewTest.releaseFeedback();});
  await page.getByText('No reviews yet',{exact:true}).waitFor();
  console.log('PASS Google directory navigation, disabled/available/failed/connected status and independent review-link setup');
 }
 await page.goto(`http://127.0.0.1:${server.address().port}/reviews`);await page.getByText('Fictional reviewer',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Draft a reply',exact:true}).click();await page.getByLabel('Google review reply').waitFor();
 assert.ok(await page.getByRole('button',{name:'Approve & publish reply',exact:true}).isDisabled());
 const approval=page.getByRole('checkbox',{name:'I approve these exact words as a public reply on Google.'});await approval.check();await page.getByLabel('Google review reply').fill('Thank you for the lovely feedback.');assert.ok(await page.getByRole('button',{name:'Approve & publish reply',exact:true}).isDisabled());assert.equal((await page.evaluate(()=>window.__reviewTest.sends)).length,0);
 await approval.check();await page.getByRole('button',{name:'Approve & publish reply',exact:true}).click();await page.getByRole('alert').filter({hasText:'uncertain'}).waitFor();assert.equal(await page.getByLabel('Google review reply').inputValue(),'Thank you for the lovely feedback.');assert.equal((await page.evaluate(()=>window.__reviewTest.sends)).length,1);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Google reviews overflow at ${width}`);
 if(output)await page.screenshot({path:join(output,`google-reviews-${width}.png`),fullPage:true});
 await page.goto(`http://127.0.0.1:${server.address().port}/content`);await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByText('£65.00',{exact:true}).first().waitFor();await page.getByLabel('Results post').selectOption('11111111-1111-4111-8111-111111111111');await page.getByRole('button',{name:'Get booking link',exact:true}).click();await page.getByLabel('Post booking link').waitFor();assert.match(await page.getByLabel('Post booking link').inputValue(),/fl_content=a{32}/);assert.equal(await page.evaluate(()=>window.__reviewTest.links),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Results overflow at ${width}`);
 if(output)await page.screenshot({path:join(output,`content-results-${width}.png`),fullPage:true});
 await page.evaluate(()=>window.__reviewTest.resultsFail=true);await page.getByRole('button',{name:'Your posts',exact:true}).click();await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByRole('alert').filter({hasText:'could not be loaded'}).waitFor();assert.equal(await page.getByText('0',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log(`PASS reviews approval, uncertain send, content links/results, failure and layout ${width}px`);await ctx.close();
}}finally{await browser.close();server.close();}
