// Complete a post using isolated fixtures. No provider publishing or live storage.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import http from 'node:http';
import {launch} from './lib/browser.mjs';
import {fetchStubSource,sessionSeedSource,bundleSupabaseUrl} from './lib/fixtures.mjs';
const dist=new URL('../dist',import.meta.url).pathname;
const server=http.createServer((req,res)=>{let file=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(file)||!extname(file))file=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream');try{res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}}).listen(0);
const browser=await launch();
const screenshots=process.env.CONTENT_CHECK_SCREENSHOTS;
if(screenshots)mkdirSync(screenshots,{recursive:true});
try {
 const ctx=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/London'});
 await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await ctx.addInitScript(fetchStubSource());await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
 await ctx.addInitScript(()=>{
  const base=window.fetch;const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}));
  window.__c={uploadFail:true,scheduleFail:true,aiFail:true,ideas:0,reads:[],patches:[],inserts:[],captions:[],posts:[{id:'d1',status:'draft',post_type:'general',caption:'My original draft',hashtags:[],image_url:null,stream_id:null,created_at:'2026-09-07T09:00:00Z'},{id:'d2',status:'draft',post_type:'general',caption:'Campaign draft',hashtags:[],image_url:null,stream_id:'s1',created_at:'2026-09-07T08:00:00Z'}]};
  window.fetch=(input,opts={})=>{
   const url=String(input),method=opts.method||'GET',c=window.__c;
   if(url.includes('/rest/v1/treatments'))return json([{id:'t1',name:'Lash lift & tint',category:'lashes',is_active:true}]);
   if(url.includes('/api/content/suggestions')){c.ideas++;return json({suggestions:[]});}
   if(url.includes('/api/content/caption')){c.captions.push(JSON.parse(opts.body));return c.aiFail?json({error:'Synthetic AI unavailable'},503):json({caption:'A new caption for lash lifts.',hashtags:['#lashes']});}
   if(url.includes('/api/instagram/status'))return json({connected:true,token_valid:true});
   if(url.includes('/api/content/streams/'))return json({});
   if(url.includes('/api/content/streams'))return json({streams:[{id:'s1',name:'Campaign A'}]});
   if(/\/api\/content(?:\?|$)/.test(url)){c.reads.push(url);return json({posts:url.includes('stream_id=s1')?c.posts.filter(p=>p.stream_id==='s1'):c.posts});}
   if(url.includes('/storage/v1/object/')&&method==='POST')return c.uploadFail?json({message:'Synthetic upload refused'},500):json({Key:'saved'});
   if(url.includes('/api/content/d1/schedule')){if(c.scheduleFail)return json({error:'Synthetic scheduling refused'},503);const body=JSON.parse(opts.body);Object.assign(c.posts[0],{status:body.scheduled_for?'scheduled':'draft',scheduled_for:body.scheduled_for});return json({post:c.posts[0]});}
   if(url.includes('/api/content/d1')&&method==='PATCH'){const body=JSON.parse(opts.body);c.patches.push(body);Object.assign(c.posts[0],body);return json({post:c.posts[0]});}
   if(url.includes('/rest/v1/content_posts')){
    if(method==='POST'){const body=JSON.parse(opts.body);c.inserts.push(body);const post={id:'created-'+c.inserts.length,...body};c.posts.push(post);return json(post);}
    return json([{id:'g1',post_type:'gallery',before_url:'https://example.com/before.jpg',after_url:'https://example.com/after.jpg',treatment_name:'Lash lift',caption:'My saved gallery caption',created_at:'2026-09-01'}]);
   }
   return base(input,opts);
  };
 });
 const page=await ctx.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/content`);
 await page.getByRole('button',{name:'Find ideas from recent work',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__c.ideas),0);
 await page.getByRole('button',{name:'Campaign A',exact:true}).click();await page.getByRole('button',{name:/^Drafts/}).click();
 await page.getByText('Campaign draft',{exact:true}).last().waitFor();assert.equal(await page.getByText('My original draft',{exact:true}).count(),0);
 await page.getByRole('button',{name:'All',exact:true}).click();await page.getByText('My original draft',{exact:true}).last().waitFor();
 await page.getByRole('button',{name:'Add a photo',exact:true}).first().click();
 await page.getByRole('textbox',{name:'Draft caption',exact:true}).fill('My revised draft');
 await page.getByLabel('Draft photo',{exact:true}).setInputFiles({name:'brows.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=','base64')});
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('alert').filter({hasText:'Could not save this draft'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Draft caption',exact:true}).inputValue(),'My revised draft');assert.equal(await page.evaluate(()=>window.__c.patches.length),0);
 await page.evaluate(()=>window.__c.uploadFail=false);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('textbox',{name:'Draft caption',exact:true}).waitFor({state:'hidden'});
 await page.getByText('My revised draft',{exact:true}).last().waitFor();
 const patch=await page.evaluate(()=>window.__c.patches[0]);assert.match(patch.image_url,/\/storage\/v1\/object\/public\/content-images\//);assert.equal(await page.evaluate(()=>window.__c.inserts.length),0);
 await page.getByRole('button',{name:'Choose posting time',exact:true}).first().click();await page.getByLabel('Posting date and time').fill('2099-07-01T13:00');
 await page.getByRole('button',{name:'Schedule post',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic scheduling refused'}).waitFor();assert.equal(await page.getByLabel('Posting date and time').inputValue(),'2099-07-01T13:00');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Schedule panel fits the phone');
 if(screenshots)await page.screenshot({path:join(screenshots,'schedule.png'),fullPage:true});
 await page.evaluate(()=>window.__c.scheduleFail=false);await page.getByRole('button',{name:'Schedule post',exact:true}).click();await page.getByRole('button',{name:'Change time',exact:true}).waitFor();
 await page.getByRole('button',{name:'Return to drafts',exact:true}).click();await page.getByRole('button',{name:'Return to drafts',exact:true}).waitFor({state:'hidden'});
 console.log('✓ Content: All stream recovers, photo failure preserves edits, photo saved on same draft, schedule retry and unschedule work');
 await page.getByRole('button',{name:'New Post',exact:true}).click();
 await page.locator('input[type=file]').first().setInputFiles({name:'lash.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=','base64')});
 await page.getByLabel('Caption treatment').selectOption({label:'Lash lift & tint'});await page.getByLabel('Caption brief').fill('Explain how to prepare for a lash lift.');await page.getByLabel('Post caption',{exact:true}).fill('Keep my words');
 await page.getByRole('button',{name:'Write with AI',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic AI unavailable'}).waitFor();assert.equal(await page.getByLabel('Post caption',{exact:true}).inputValue(),'Keep my words');
 await page.evaluate(()=>window.__c.aiFail=false);await page.getByRole('button',{name:'Write with AI',exact:true}).click();await page.getByRole('button',{name:'Use this caption',exact:true}).waitFor();assert.equal(await page.getByLabel('Post caption',{exact:true}).inputValue(),'Keep my words');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'AI editor fits the phone');
 if(screenshots)await page.screenshot({path:join(screenshots,'caption.png'),fullPage:true});
 const sent=await page.evaluate(()=>window.__c.captions.at(-1));assert.equal(sent.treatment_type,'Lash lift & tint');assert.match(sent.context,/Explain how to prepare/);assert.match(sent.image_url,/\/storage\/v1\/object\/public\/content-images\//);
 await page.getByRole('button',{name:'Use this caption',exact:true}).click();assert.equal(await page.getByLabel('Post caption',{exact:true}).inputValue(),'A new caption for lash lifts.');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Gallery',exact:true}).click();await page.getByRole('button',{name:'Draft with this after photo',exact:true}).click();await page.getByRole('button',{name:'Save as Draft',exact:true}).click();
 await page.getByText('My saved gallery caption',{exact:true}).last().waitFor();assert.equal(await page.evaluate(()=>window.__c.inserts.at(-1).image_url),'https://example.com/after.jpg');assert.equal(await page.evaluate(()=>window.__c.inserts.at(-1).post_type),'before_after');
 console.log('✓ Content: AI uses the selected treatment and brief, preserves writing until accepted, and gallery photo becomes a separate draft');
 await ctx.close();
} finally {await browser.close();server.close();}
