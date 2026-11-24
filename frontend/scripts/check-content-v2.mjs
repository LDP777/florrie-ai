// Built app, fictional salon and intercepted APIs. Provider traffic is blocked.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { webkit } from '@playwright/test';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const require=createRequire(import.meta.url);
const dist=new URL('../dist',import.meta.url).pathname;
const output=process.env.VISUAL_OUTPUT_DIR;
const hasSupabase=existsSync(join(dist,'assets'))&&readdirSync(join(dist,'assets')).filter(name=>/^(supabase|index)-.*\.js$/.test(name)).some(name=>/https:\/\/[a-z0-9-]+\.supabase\.co/.test(readFileSync(join(dist,'assets',name),'utf8')));
if(!hasSupabase)throw new Error('Build with VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder VITE_API_URL=https://api.florrie.ai before running Content v2 browser checks.');
const fontRoot=new URL('../../backend/src/services/content-v2/fonts/',import.meta.url).pathname;
const sizes=[[320,568],[375,667],[390,844],[430,932]];
const engines=process.env.CONTENT_V2_BROWSER?[process.env.CONTENT_V2_BROWSER]:['chromium','webkit'];
const now=new Date('2026-11-23T10:00:00Z');
const axe=readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
const reference=process.env.CONTENT_V2_REFERENCE;
const artwork=process.env.CONTENT_V2_ARTWORK;
if(output)mkdirSync(output,{recursive:true});
const files=['lash-lift-after.jpg','brow-lamination-after.jpg','brow-lamination-before.jpg','studio-flatlay.jpg'];
const server=http.createServer((req,res)=>{
  const path=(req.url||'/').split('?')[0];
  if(path.startsWith('/__content-font/')){
    const name=path.split('/').at(-1);
    if(!['PlayfairDisplay.ttf','PlusJakartaSans.ttf'].includes(name)){res.statusCode=404;res.end();return;}
    res.setHeader('content-type','font/ttf');res.end(readFileSync(join(fontRoot,name)));return;
  }
  if(path.startsWith('/__content-photo/')){
    const number=Number(path.split('/').at(-1))||0, name=files[number%files.length];
    const card=number===1?'before_after.jpg':number===2?'offer.jpg':null;
    if(card&&artwork&&existsSync(join(artwork,card))){res.setHeader('content-type','image/jpeg');res.end(readFileSync(join(artwork,card)));return;}
    if(reference&&existsSync(join(reference,name))){res.setHeader('content-type','image/jpeg');res.end(readFileSync(join(reference,name)));return;}
    res.setHeader('content-type','image/svg+xml');
    const colours=['#d5ad92','#bc8e74','#ead4c3','#92405e'];
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="${colours[number%4]}"/><path d="M180 520 Q520 350 900 490 Q620 430 200 580" fill="#392820"/><path d="M200 800 Q570 1050 880 800" fill="none" stroke="#392820" stroke-width="12"/><text x="80" y="1200" font-family="Georgia" font-size="42" fill="#241b17">Wren Brow &amp; Lash</text></svg>`);return;
  }
  let file=join(dist,path);if(!existsSync(file)||!extname(file))file=join(dist,'index.html');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'})[extname(file)]||'text/html');
  try{const content=readFileSync(file);res.end(extname(file)==='.html'?content.toString().replace('</head>',`<style>@font-face{font-family:'Playfair Display';src:url('/__content-font/PlayfairDisplay.ttf')}@font-face{font-family:'Plus Jakarta Sans';src:url('/__content-font/PlusJakartaSans.ttf')}</style></head>`):content);}catch{res.statusCode=404;res.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const base=`http://127.0.0.1:${server.address().port}`;
const failures=[],checks=[];
function fixtureSource({mode,base}) {
  const fallback=window.fetch;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
  const captions=["Thursday afternoon has opened up. I've got space from 2pm for a lash lift and tint (£50) or a brow lamination and tint (£45). New to me? You'll need a quick patch test by Tuesday. Booking link is in my bio, or give me a message x", "Brow lamination and tint from this week. Brushed up, set and tinted to suit. Lasts 6 to 8 weeks with a little aftercare. It's £45, and the booking link is in my bio x",'A little festive treat. £10 off a lash lift and tint for appointments from 1 to 24 December, so it’s £40 instead of £50. Book by 20 December with code FESTIVE10. One per client. Booking link is in my bio x'];
  const posts=ids.slice(0,3).map((id,index)=>({id,kind:'post',status:'draft',state:'Ready to check',version:1,material_hash:`hash-${index}`,approved_hash:null,post_type:index===0?'last_minute_availability':index===1?'before_after':'promotion',caption:captions[index],hashtags:['#brows','#lashlift'],prepared_caption:captions[index],image_url:`${base}/__content-photo/${index}`,media:{type:'photo',photo_id:'photo1'},alternatives:[{type:'photo',photo_id:'photo2'}],claims:[{kind:'price',text:index===2?'£40':'£45'},{kind:'price',text:'£50'}],facts:[{key:'price',label:'Lash lift and tint is £50',private_label:'Treatment price ••••',source:'Price list',status:'ok',checked_at:'2026-11-23T09:20:00Z'},{key:'free',label:'Free Thursday from 2pm',private_label:'Free Thursday from 2pm',source:'Diary',status:'ok'},{key:'permission',label:'Jess said yes to this photo on Instagram',private_label:'A client said yes to this photo',source:'Photo consent',status:'ok'}],purpose:{type:index===0?'fill_gap':index===1?'show_work':'offer',title:['Fills Thursday from 2pm','Brow lamination and tint, before and after','Festive lash lift'][index],eyebrow:["For Thursday's free afternoon",'Shows off your work','Your approved offer'][index],label:['Thu gap','Brows','Offer'][index]},timing:{at:`2026-11-${23+index}T19:30:00.000Z`,reason:index===0?'3 evenings before Thursday, so there is time to book and patch test':'Spaced away from your other posts this week'},link_url:`https://wren.example/book?fl_content=${id}`,created_at:'2026-11-22T18:00:00Z',history:[],can_undo:false}));
  const reel={id:ids[3],kind:'reel_plan',status:'draft',state:'To film',purpose:{title:'Lash lift reveal',type:'reel'},caption:'A closer look at a lash lift and tint.',reel:{length:'About 15 seconds',shots:[{instruction:'Film the closed eyes before the treatment',seconds:4,on_screen_words:'Before'},{instruction:'Film the finished lashes',seconds:5,on_screen_words:'After'},{instruction:'Show the finished look',seconds:6,on_screen_words:'Book through my bio'}],needs:["Your client's OK to film her eyes for Instagram"]}};
  let saved;try{saved=JSON.parse(sessionStorage.getItem('cv2-fixture')||'null');}catch{}
  const state=window.cv2=saved||{mode,posts:mode==='first'||mode==='preparing'?[]:posts,reel:mode==='first'||mode==='preparing'?[]:[reel],writes:[],preparation:null,connected:mode!=='waiting',conflict:false,failSave:false,rules:[],deleted:[],unexpected:[]};
  if(!saved){
    if(mode==='changed'){state.posts[0].caption=state.posts[0].caption.replace('from 2pm','from 3pm');state.posts[0].purpose.title='Fills Thursday from 3pm';state.posts[0].facts[1].label='Free Thursday from 3pm';state.posts[0].facts[1].private_label='Free Thursday from 3pm';state.posts[0].change_note={kind:'facts',was_approved:true,reasons:['2pm on Thursday was booked'],changes:[{from:'from 2pm',to:'from 3pm'}]};state.posts[0].state='Needs your OK again';}
    if(mode==='withdrawn'){state.posts[0].facts[2].status='block';state.posts[0].facts[2].label='Jess withdrew permission for this photo.';state.posts[0].change_note={kind:'blocked',was_approved:true,reasons:['Jess withdrew permission for this photo.']};state.posts[0].state='Needs a decision';}
    if(['failed','waiting','posted','unconfirmed','posting'].includes(mode)){const post=state.posts.shift();post.status=mode==='failed'?'failed':mode==='posted'||mode==='unconfirmed'?'posted':'scheduled';post.state=({failed:"Didn't post",waiting:'Waiting for Instagram',posted:'Posted',unconfirmed:'Needs a decision',posting:'Posting'})[mode];post.approved_hash=post.material_hash;post.failure_reason='Instagram refused this image. Choose a supported image.';post.posted_at='2026-11-23T09:00:00Z';if(mode==='posted')post.external_post_id='ig-test-confirmed';if(mode==='posting')post.publish_claimed_at='2026-11-23T09:59:00Z';state.posts.push(post);}
    if(mode==='preparing')state.preparation={id:'55555555-5555-4555-8555-555555555555',status:'running',step:2,label:'your posts',details:{steps:[{label:'Checking your diary',result:'Thursday is free from 2pm',status:'done'},{label:'Choosing photos you can use',result:'2 photos with permission',status:'done'}]}};
  }
  const persist=()=>sessionStorage.setItem('cv2-fixture',JSON.stringify(state));persist();
  const home=()=>({posts_to_check:state.posts.filter(p=>p.status==='draft'),coming_up:state.posts.filter(p=>p.status!=='draft'),reel_plans:state.reel,preparation:state.preparation,results_summary:{bookings:3,value_pence:14500},connections:{instagram:{connected:state.connected,needs_reconnect:!state.connected,username:'wren.browlash'},google:{connected:false}},ideas:[{id:'gap',label:'Help fill Saturday',text:'Help fill Saturday'},{id:'photos',type:'show_work',label:'Show off these brows'},{id:'week',label:"Sort next week's posts",request:{type:'week'}}],counts:{total:state.posts.length+state.reel.length,photos:2,offers:1,voice_rules:state.rules.length}});
  const owner={id:'b1',email:'owner@wren.test',business_name:'Wren Brow & Lash',first_name:'Wren',content_v2:true,owner_access_approved: true, onboarding_completed_at:'2026-01-01T00:00:00Z',trial_ends_at:'2099-01-01T00:00:00Z',subscription_status:'active',subscription_plan:'florrie',plan:'pro',timezone:'Europe/London',instagram_username:'wren.browlash'};
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname,method=options.method||'GET';
    if(path.endsWith('/beauticians'))return json(owner);
    if(path==='/api/auth/me')return json({beautician:owner});
    if(path.startsWith('/api/content/v2/')){
      const sub=path.slice('/api/content/v2'.length),body=options.body?JSON.parse(options.body):{};
      if(method!=='GET'){state.writes.push({sub,method,body});persist();}
      if(sub==='/home')return json(home());
      if(sub==='/photos'){
        if(mode==='first')await new Promise(resolve=>{window.releaseFirstPhotos=resolve;});
        return json({photos:[],treatments:[{id:'t1',name:'Brow lamination and tint'}],clients:[{id:'c1',first_name:'Jess',last_name:'Example'}]});
      }
      if(sub==='/voice'&&method==='GET')return json({rules:state.rules.length?state.rules:[{id:'rule1',kind:'replace',from_text:'appointments',to_text:'spaces'}]});
      if(sub.startsWith('/voice/')&&method==='DELETE'){state.rules=[];persist();return json({forgotten:true});}
      if(sub==='/offers')return json({offers:[{id:'offer1',title:'Festive lash lift',code:'FESTIVE10',terms:'One per client.',client_reply:'£10 off a lash lift and tint for appointments from 1 to 24 December. It is £40 instead of £50. Book by 20 December with code FESTIVE10. One per client.'}]});
      if(sub.startsWith('/results'))return json({measured:[{post_id:ids[0],title:'Thursday afternoon',bookings:3,value_pence:14500}],total:{bookings:3,value_pence:14500,pending:1,cancelled:1},inferred:[{explanation:'Florrie thinks "Brows" may have helped a brow booking made today. It did not come through the link, so it is not counted above.'}]});
      if(sub==='/posts')return json({posts:state.posts.filter(p=>p.status==='posted')});
      if(sub==='/preparations'||sub==='/ask'){if(body.text&&/brow/i.test(body.text))return json({needs:'photos'});state.preparation={id:'55555555-5555-4555-8555-555555555555',status:'running',step:2,label:'your posts',details:{steps:[{result:'Thursday is free from 2pm'},{result:'2 photos with permission'}]}};persist();return json(state.preparation);}
      if(sub.startsWith('/preparations/'))return json(state.preparation);
      const match=sub.match(/^\/posts\/([^/]+)(?:\/(.+))?$/);
      if(match){const post=state.posts.find(p=>p.id===match[1])||state.reel.find(p=>p.id===match[1])||state.deleted.find(p=>p.id===match[1]);if(!post)return json({error:'Not found'},404);const action=match[2];if(method==='GET')return json({post});
        if(!action&&method==='PATCH'){
          if(state.failSave)return json({error:'Your words could not be saved.'},503);
          if(state.conflict){state.conflict=false;post.version++;post.caption='The version saved on another device.';persist();return json({error:'This post changed elsewhere.',post},409);}
          if(body.expected_version!==post.version)return json({error:'This post changed elsewhere.',post},409);
          post.history.push(clone(post));post.caption=body.caption;if(body.hashtags)post.hashtags=body.hashtags;post.version++;post.material_hash=`edited-${post.version}`;post.status='draft';post.state='Ready to check';post.edited_by_owner=true;
        }else if(action==='approve'){if(body.expected_hash!==post.material_hash)return json({error:'This post changed since you checked it.',post},409);post.status='scheduled';post.state='Scheduled';post.approved_hash=post.material_hash;}
        else if(action==='revise'){post.history.push(clone(post));if(body.instruction==='other_photo'){post.image_url=`${base}/__content-photo/3`;post.last_revision='Photo changed. The words are the same.';post.change_note=null;post.facts.forEach(f=>{if(f.status==='block')f.status='ok';});}else{post.caption=post.caption.replace('has opened up.','is free.').replace('A little festive treat. ','');post.last_revision='Softer wording. The facts are the same.';}post.version++;post.material_hash=`revised-${post.version}`;post.can_undo=true;}
        else if(action==='undo'){const previous=post.history.pop();if(previous)Object.assign(post,previous);post.version++;post.material_hash=`undo-${post.version}`;post.can_undo=post.history.length>0;}
        else if(action==='timing'){post.timing.at=body.at;post.state=body.at?'Scheduled':'Approved, not scheduled';}
        else if(action==='move-back'){post.status='draft';post.state='Ready to check';post.approved_hash=null;}
        else if(action==='retry'){post.status='scheduled';post.state=state.connected?'Scheduled':'Waiting for Instagram';}
        else if(action==='posted-by-owner'){post.status='posted';post.state='Posted';post.published_by_owner=true;}
        else if(action==='restore'){state.deleted=state.deleted.filter(p=>p.id!==post.id);(post.kind==='reel_plan'?state.reel:state.posts).push(post);}
        else if(method==='DELETE'){if(state.failDelete)return json({error:'Could not delete this draft. Try again.'},503);state.posts=state.posts.filter(p=>p.id!==post.id);state.reel=state.reel.filter(p=>p.id!==post.id);state.deleted.push(post);}
        else if(action!=='post-now'){state.unexpected.push(`${method} ${sub}`);persist();return json({error:'Unexpected mutation'},500);}
        persist();return json({post,note:post.last_revision,learned_rules:[]});
      }
      state.unexpected.push(`${method} ${sub}`);persist();return json({error:'Unexpected fixture request'},500);
    }
    if(method!=='GET'&&!path.startsWith('/auth/')){state.unexpected.push(`${method} ${path}`);persist();return json({error:'Unexpected write blocked'},409);}
    return fallback(input,options);
  };
}
async function fixture(browser,mode='ready',width=390,height=844){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(15000);
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const source=`${fetchStubSource()}\n${sessionSeedSource(bundleSupabaseUrl(dist)).replaceAll('ellie@ellindigo.test','owner@wren.test')}\n(${fixtureSource.toString()})(${JSON.stringify({mode,base})});`;
  await context.addInitScript(source);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(now);await page.goto(base+'/content');
  await page.addStyleTag({content:`@font-face{font-family:'Playfair Display';src:url('${base}/__content-font/PlayfairDisplay.ttf')}@font-face{font-family:'Plus Jakarta Sans';src:url('${base}/__content-font/PlusJakartaSans.ttf')}`});
  await page.evaluate(()=>document.fonts.ready);
  try{await page.locator('.cv2-ready').waitFor({timeout:10000});}catch(error){const body=(await page.locator('body').innerText()).slice(0,600);await context.close();throw new Error(`Content did not load: ${body}; browser errors: ${errors.join(', ')}; ${error.message}`);}
  return{context,page,errors};
}
async function audit(page,label){await page.evaluate(axe);const result=await page.evaluate(async()=>{const results=await window.axe.run({include:[document.querySelector('[data-content-dialog]:last-of-type')||document.querySelector('.cv2-page')]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});return results.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));});assert.deepEqual(result,[],`${label}: WCAG A/AA violations ${JSON.stringify(result)}`);}
async function shot(page,name,engine,width){if(output&&width===390){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(output,`${engine}-${name}.png`)});}}
async function clean(f){assert.deepEqual(f.errors,[],'No uncaught browser errors');assert.deepEqual(await f.page.evaluate(()=>cv2.unexpected),[],'Only fixture-approved endpoints were called');await f.context.close();}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
try {
for(const engine of engines){const browser=await(engine==='webkit'?webkit.launch():launch());try{
for(const [width,height] of sizes){
  console.log(`Checking ${engine} at ${width} x ${height}`);
  let f=await fixture(browser,'ready',width,height),p=f.page;
  const primary=p.locator('.cv2-page .fl-btn--primary:visible');assert.equal(await primary.count(),1);
  const bounds=await button(p,'Check 3 posts').boundingBox();const dock=await p.locator('.fl-app-dock').boundingBox();assert.ok(bounds.y+bounds.height<=(dock?.y||height-80)+1,`Primary above dock at ${width}`);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No home overflow');
  const typography=await p.evaluate(()=>{
    const title=getComputedStyle(document.querySelector('.fl-content-heading h1'));
    const section=getComputedStyle(document.querySelector('.cv2-section h2'));
    const root=getComputedStyle(document.documentElement);
    return {titleFamily:title.fontFamily,titleSize:title.fontSize,titleWeight:title.fontWeight,sectionFamily:section.fontFamily,
      body:getComputedStyle(document.body).fontFamily,display:root.getPropertyValue('--font-display').trim(),size:root.getPropertyValue('--fl-title').trim()};
  });
  assert.equal(typography.titleSize,typography.size,'Content uses the shared page-title size');
  assert.equal(typography.titleWeight,'600');
  assert.equal(typography.sectionFamily.split(',')[0],typography.body.split(',')[0],'Content sections use the app body font');
  assert.ok(typography.titleFamily.includes('Playfair Display'),'Content keeps the shared display title');
  await shot(p,'01-home',engine,width);if(width===390)await audit(p,`${engine} home`);
  await button(p,'Check 3 posts').click();await p.getByRole('heading',{name:'1 of 3',exact:true}).waitFor();
  await shot(p,'02-review-1',engine,width);if(width===390)await audit(p,`${engine} deck`);
  for(let i=0;i<3;i++){const approve=button(p,'Approve');const b=await approve.boundingBox();assert.ok(b.y+b.height<=height+1&&b.y>=0,'Approval stays visible without scrolling');await approve.click();await p.getByRole('heading',{name:i<2?`${i+2} of 3`:'3 posts approved',exact:true}).waitFor();}
  await shot(p,'07-done',engine,width);await button(p,'Done').click();await p.getByRole('heading',{name:'Nothing to check',exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>cv2.posts.filter(post=>post.state==='Scheduled').length),3);assert.equal(await p.evaluate(()=>cv2.writes.filter(write=>write.sub.endsWith('/approve')).length),3);
  await shot(p,'08-home-after',engine,width);await clean(f);checks.push(`${engine} ${width}: five taps, layout, scheduled`);

  f=await fixture(browser,'ready',width,height);p=f.page;await button(p,'Check 3 posts').click();
  const remove=button(p,'Delete draft'),removeBounds=await remove.boundingBox();
  assert.ok(removeBounds.y>=0&&removeBounds.x>=0&&removeBounds.x+removeBounds.width<=width&&removeBounds.height>=44,'Delete is visible and tappable without scrolling');
  await shot(p,'26-delete-draft',engine,width);
  if(width===390){
    await p.evaluate(()=>{cv2.failDelete=true;});await remove.click();
    await p.locator('.cv2-toast').getByText('Could not delete this draft. Try again.',{exact:true}).waitFor();
    assert.equal(await p.getByRole('heading',{name:'1 of 3',exact:true}).isVisible(),true);
    assert.equal(await p.evaluate(()=>cv2.posts.length),3);await p.evaluate(()=>{cv2.failDelete=false;});
  }
  await remove.click();await p.getByRole('heading',{name:'2 of 3',exact:true}).waitFor();
  await p.locator('.cv2-toast').getByRole('button',{name:'Undo',exact:true}).click();
  await button(p,'Check 3 posts').waitFor();assert.equal(await p.locator('.cv2-review-deck').count(),0);
  await p.reload();await button(p,'Check 3 posts').click();
  for(let i=0;i<3;i++){await button(p,'Delete draft').click();await p.getByRole('heading',{name:i<2?`${i+2} of 3`:'Review finished',exact:true}).waitFor();}
  assert.equal(await p.getByRole('button',{name:'Connect Instagram',exact:true}).count(),0);
  assert.equal(await p.evaluate(()=>cv2.writes.filter(w=>w.sub.endsWith('/approve')).length),0);
  await button(p,'Done').click();await p.getByRole('heading',{name:'Nothing to check',exact:true}).waitFor();
  await p.reload();await p.getByRole('heading',{name:'Nothing to check',exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>cv2.posts.length),0,'Deleted drafts stay removed after reload');
  await p.locator('.cv2-item-row').filter({hasText:'Lash lift reveal'}).click();await button(p,'Delete reel draft').click();
  await p.waitForFunction(()=>cv2.reel.length===0);await p.locator('.cv2-toast').getByRole('button',{name:'Undo',exact:true}).click();
  await p.locator('.cv2-item-row').filter({hasText:'Lash lift reveal'}).waitFor();
  assert.equal(await p.evaluate(()=>cv2.reel.length),1);await clean(f);
  checks.push(`${engine} ${width}: visible delete, Undo, empty review, reload persistence, reel deletion and restore`);

  f=await fixture(browser,'ready',width,height);p=f.page;await button(p,'Check 3 posts').click();
  const before=await p.evaluate(()=>({caption:cv2.posts[0].caption,image:cv2.posts[0].image_url}));
  await button(p,'Change').click();await p.getByRole('heading',{name:'What should change?',exact:true}).waitFor();await shot(p,'04-change-sheet',engine,width);if(width===390)await audit(p,`${engine} change`);
  await button(p,'Use the other photo').click();await p.waitForFunction(image=>cv2.posts[0].image_url!==image,before.image);assert.equal(await p.evaluate(()=>cv2.posts[0].caption),before.caption);
  await p.locator('.cv2-revision').getByRole('button',{name:'Undo',exact:true}).click();await p.waitForFunction(image=>cv2.posts[0].image_url===image,before.image);
  await button(p,'Change').click();await button(p,'Less salesy').click();await p.waitForFunction(()=>cv2.posts[0].caption.includes('Thursday afternoon is free.'));assert.equal(await p.evaluate(()=>cv2.posts[0].image_url),before.image);assert.match(await p.evaluate(()=>cv2.posts[0].caption),/£50.*£45.*patch test by Tuesday/);
  await shot(p,'06-less-salesy',engine,width);
  await p.reload();await p.getByRole('heading',{name:'1 of 3',exact:true}).waitFor();assert.match(await p.locator('.cv2-preview-copy').innerText(),/Thursday afternoon is free/);
  await p.locator('.cv2-facts').scrollIntoViewIfNeeded();await shot(p,'02-review-1-facts',engine,width);
  await button(p,'Close and come back later').click();await p.getByRole('heading',{name:'Content',exact:true}).waitFor();
  await button(p,'Hide client details').click();await button(p,'Show client details to check posts').waitFor();assert.equal(await button(p,'Show client details to check posts').isDisabled(),true);assert.equal(await p.locator('.cv2-page .cv2-image img').count(),0);assert.doesNotMatch(await p.locator('.cv2-page').innerText(),/£145|£50|Jess|Thursday afternoon is free/);await shot(p,'18-privacy',engine,width);await clean(f);checks.push(`${engine} ${width}: isolated revisions, undo, persisted deck, privacy`);

  for(const mode of ['changed','withdrawn']){f=await fixture(browser,mode,width,height);p=f.page;await button(p,'Check 3 posts').click();if(mode==='changed'){await p.getByText('Changed since you approved it',{exact:true}).waitFor();assert.match(await p.locator('.cv2-preview-copy mark').innerText(),/from 3pm/);await shot(p,'10-fact-changed-review',engine,width);}else{await p.getByText("This can't go out as it is",{exact:true}).waitFor();assert.equal(await button(p,'Use a different photo').isVisible(),true);await shot(p,'11-permission-withdrawn',engine,width);}await clean(f);}
  for(const mode of ['failed','waiting']){f=await fixture(browser,mode,width,height);p=f.page;if(mode==='waiting'){await p.getByText('Instagram signed you out',{exact:true}).waitFor();assert.equal(await button(p,'Reconnect Instagram').isVisible(),true);await shot(p,'15-signed-out',engine,width);}else{await button(p,'See what happened').click();await p.getByRole('heading',{name:'Your post',exact:true}).waitFor();assert.match(await p.locator('.cv2-sheet-body').innerText(),/Instagram refused this image/);await shot(p,'14-failed',engine,width);if(width===390)await audit(p,`${engine} item`);await button(p,'Post it yourself').click();await p.getByRole('heading',{name:'Post it yourself',exact:true}).waitFor();assert.match(await p.locator('.cv2-sheet-body').innerText(),/Florrie can't confirm these posts/);await button(p,'Close sheet').last().click();await p.locator('.cv2-item-row').filter({hasText:"Didn't post"}).click();await button(p,'Try again').click();await p.waitForFunction(()=>cv2.posts.some(post=>post.purpose.label==='Thu gap'&&post.status==='scheduled'));}await clean(f);}
  for(const mode of ['first','preparing']){f=await fixture(browser,mode,width,height);p=f.page;if(mode==='first'){await p.getByRole('heading',{name:'Your first posts, ready in a minute',exact:true}).waitFor();await p.waitForFunction(()=>typeof window.releaseFirstPhotos==='function');assert.equal(await button(p,'Prepare my posts').isEnabled(),true,'Home is usable while photos are still pending');await p.evaluate(()=>window.releaseFirstPhotos());await shot(p,'19-first-visit',engine,width);if(width===390)await audit(p,`${engine} first visit`);await button(p,'Prepare my posts').click();}else{await shot(p,'20-preparing',engine,width);}await p.getByRole('heading',{name:'Preparing your posts',exact:true}).waitFor();await p.reload();await p.getByRole('heading',{name:'Preparing your posts',exact:true}).waitFor();assert.equal(await p.locator('.cv2-steps li.is-done').count(),2);assert.match(await p.locator('.cv2-steps').innerText(),/Thursday is free from 2pm/);await clean(f);}
  checks.push(`${engine} ${width}: changed facts, consent block, failure/retry, connection, first visit, durable preparation`);
  if(width===390){f=await fixture(browser,'ready',width,height);p=f.page;await p.locator('.cv2-item-row').filter({hasText:'Lash lift reveal'}).click();await p.getByText('You film this.',{exact:true}).waitFor();await shot(p,'22-reel-plan',engine,width);await button(p,'Close sheet').last().click();await p.locator('.cv2-results-line').click();await p.getByRole('heading',{name:'Bookings from your posts',exact:true}).waitFor();assert.match(await p.locator('.cv2-sheet-body').innerText(),/Not measured/);await shot(p,'23-results',engine,width);await button(p,'Close sheet').last().click();await p.locator('.cv2-tool').filter({hasText:'Offers'}).click();await p.getByRole('heading',{name:'Offers',exact:true}).waitFor();assert.match(await p.locator('.cv2-sheet-body').innerText(),/FESTIVE10.*One per client/s);await shot(p,'24-offers',engine,width);await button(p,'Close sheet').last().click();await p.locator('.cv2-tool').filter({hasText:'How you write'}).click();await p.getByRole('heading',{name:'How you write',exact:true}).waitFor();await shot(p,'25-voice',engine,width);await clean(f);}
  if(width===390){
    f=await fixture(browser,'ready',width,height);p=f.page;
    await button(p,'Check 3 posts').click();await button(p,'Change').click();await button(p,'Edit the words myself').click();
    await p.evaluate(()=>{cv2.conflict=true;});
    const words='My own caption, with a lash lift and tint at £50. Booking link in my bio x';
    await p.getByLabel('Your caption',{exact:true}).fill(words);
    await p.getByLabel('Hashtags',{exact:true}).fill('#brows');
    await p.getByText('This post changed elsewhere. Your words are kept here. Review the saved version before replacing it.',{exact:true}).waitFor();
    assert.equal(await p.getByLabel('Your caption',{exact:true}).inputValue(),words);
    assert.equal(await p.getByLabel('Hashtags',{exact:true}).inputValue(),'#brows');
    assert.equal(await p.evaluate(()=>cv2.posts[0].caption),'The version saved on another device.');
    await button(p,'Save my words over this version').click();await p.waitForFunction(words=>cv2.posts[0].caption===words,words);
    assert.deepEqual(await p.evaluate(()=>cv2.posts[0].hashtags),['#brows']);
    assert.ok(await p.getByLabel('Hashtags',{exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
    await button(p,'Done editing').click();assert.match(await p.locator('.cv2-preview-copy').innerText(),/My own caption/);
    await button(p,'Approve').click();await p.getByRole('heading',{name:'2 of 3',exact:true}).waitFor();
    await p.reload();await p.getByRole('heading',{name:'2 of 3',exact:true}).waitFor();
    await p.evaluate(()=>{localStorage.setItem('florrie:hide-client-details:v1','true');window.dispatchEvent(new StorageEvent('storage',{key:'florrie:hide-client-details:v1'}));});
    await button(p,'Show client details to check posts').waitFor();assert.equal(await p.locator('.cv2-review-deck').count(),0);await clean(f);
    f=await fixture(browser,'ready',width,height);p=f.page;
    await p.goto(base+'/content?post=22222222-2222-4222-8222-222222222222');await p.getByRole('heading',{name:'2 of 3',exact:true}).waitFor();
    assert.match(await p.locator('.cv2-purpose').innerText(),/Brow lamination/);await clean(f);
    checks.push(`${engine}: autosave conflict retains words, explicit replacement, reload position, privacy closes deck, exact post handoff`);
  }

}
}finally{await browser.close();}}
console.log(checks.join('\n'));console.log(`Content v2: ${checks.length} grouped journeys passed, ${engines.join(' and ')}, four phone sizes, axe A/AA on five states per engine.`);
} catch(error){failures.push(error);console.error(error);} finally{server.close();}
if(failures.length)process.exitCode=1;
