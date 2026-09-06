// Synthetic Settings-to-deletion workflow. Blocks nonlocal network traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {join,extname} from 'node:path';
import {launch} from './lib/browser.mjs';
import {fetchStubSource,sessionSeedSource,bundleSupabaseUrl} from './lib/fixtures.mjs';
const dist=process.env.ACCOUNT_DIST||new URL('../dist',import.meta.url).pathname;
const server=http.createServer((req,res)=>{let p=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(p)||!extname(p))p=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(p)]||'application/octet-stream');res.end(readFileSync(p));}).listen(0);
const browser=await launch();
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await ctx.addInitScript(fetchStubSource());
 await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
 await ctx.addInitScript(()=>{
  const base=window.fetch;window.__statusHeaders=[];
  window.fetch=(url,opts={})=>{
   if(String(url).includes('/api/auth/account')){
    if(opts.method==='DELETE'){
     if(JSON.parse(opts.body).confirm!=='DELETE')throw new Error('Deletion confirmation missing');
     localStorage.setItem('audit_deletion_requested','true');
     return Promise.resolve(new Response(JSON.stringify({success:false,deletion:{id:'deletion-test',status:'pending',completed:false,status_token:'a'.repeat(43),message:'Your cleanup request is saved.'}}),{status:202}));
    }
    window.__statusHeaders.push(opts.headers);
    return Promise.resolve(new Response(JSON.stringify(window.__failStatus?{error:'Synthetic read failure'}:{deletion:{id:'deletion-test',status:window.__completed?'completed':'pending',completed:!!window.__completed,message:window.__completed?'Account deletion is complete.':'Your cleanup request is saved.'}}),{status:window.__failStatus?503:200}));
   }
   return base(url,opts);
  };
 });
 const page=await ctx.newPage();
 page.on('dialog',dialog=>dialog.accept(dialog.type()==='prompt'?'DELETE':undefined));
 await page.goto(`http://127.0.0.1:${server.address().port}/settings?section=account`);
 await page.getByRole('button',{name:'Delete account',exact:true}).click();
 await page.waitForURL('**/account-deletion');
 await page.getByText('Your cleanup request is saved.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Account deleted',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>window.__statusHeaders[0]['X-Deletion-Token']),'a'.repeat(43));
 await page.evaluate(()=>{window.__failStatus=true;});
 await page.getByRole('button',{name:'Check progress',exact:true}).click();
 await page.getByRole('alert').waitFor();
 assert.equal(await page.getByRole('heading',{name:'Account deleted',exact:true}).count(),0);
 await page.evaluate(()=>{window.__failStatus=false;window.__completed=true;});
 await page.getByRole('button',{name:'Check progress',exact:true}).click();
 await page.getByRole('heading',{name:'Account deleted',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 console.log('PASS: confirmed Settings request shows pending, survives navigation with scoped recovery token, retains errors, and only displays deleted after confirmed completion');
 await ctx.close();
}finally{await browser.close();server.close();}
