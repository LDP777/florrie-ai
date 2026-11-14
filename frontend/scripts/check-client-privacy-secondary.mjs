// Real owner pages with synthetic client records. No provider calls or writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import { ThemeProvider } from './src/lib/theme.jsx';
    import { CoachProvider } from './src/contexts/CoachContext.jsx';
    import { ClientPrivacyProvider, ClientPrivacyToggle } from './src/contexts/ClientPrivacyContext.jsx';
    import Notifications from './src/pages/Notifications.jsx';
    import Outbox from './src/pages/Outbox.jsx';
    import MoneyTracker from './src/pages/MoneyTracker.jsx';
    import Packages from './src/pages/Packages.jsx';
    import MessageTemplates from './src/pages/MessageTemplates.jsx';
    import Aftercare from './src/pages/Aftercare.jsx';
    import Expenses from './src/pages/Expenses.jsx';
    import Analytics from './src/pages/Analytics.jsx';
    const secret='SECONDARY_PRIVATE_SENTINEL';
    const now=new Date().toISOString(), today=now.slice(0,10);
    const owner={id:'salon-a',auth_id:'user-a',business_name:'Demo Salon',booking_slug:'demo'};
    const client={first_name:secret,last_name:'Client'};
    const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    const amount={tax_year:'2026/27',as_at:today,income_cents:3000,expenses_cents:500,profit_cents:2500};
    const tables={
      clients:[{id:'client-a',...client,created_at:now}],
      appointments:[0,1,2].map(i=>({id:'appointment-'+i,client_id:'client-a',starts_at:new Date(Date.now()-864e5-i*3600e3).toISOString(),status:'completed',price_cents:3000})),
      notifications:[{id:'notification-a',category:'booking',title:secret+' booked',body:secret+' notification body',read:true,created_at:now}],
      transactions:[{id:'transaction-a',type:'payment',amount_cents:3000,created_at:now,appointments:{id:'appointment-a',starts_at:now,client_id:'client-a',clients:client,treatments:{name:'Signature brows'}}}],
      expenses:[{id:'expense-a',date:today,vendor:secret+' vendor',description:secret+' expense note',amount_cents:500,category:'products',tax_deductible:true}],
      expense_budgets:[],
      courses:[{id:'course-a',beautician_id:owner.id,name:'Brow training',date:new Date(Date.now()+7*864e5).toISOString().slice(0,10),start_time:'09:30',status:'active',price:450,deposit:100,max_students:4,enrolled:1,duration:'Full day (7hrs)',created_at:now}],
      course_enrollments:[{id:'student-a',course_id:'course-a',beautician_id:owner.id,name:secret+' student',email:secret+'@example.test',phone:'+447700900123',notes:secret+' student note',payment_status:'deposit_paid',amount_paid_cents:10000,created_at:now}],
      message_templates:[{id:'template-a',category:'custom',name:secret+' template',body:secret+' stored message',trigger:'manual',created_at:now}],
      aftercare_cards:[{id:'care-a',treatment_name:'Signature brows',instructions:[{title:secret+' instruction title',text:secret+' instruction text'}],products:[secret+' custom recommendation'],personal_note:secret+' care note',created_at:now}],
    };
    const pending=['hold-a','hold-b'].map(id=>({id,clients:client,reason:'manual_review',channel:'whatsapp',message_type:'rebook_nudge',body:secret+' draft body',created_at:now}));
    window.fixture={owner,tables,requests:[],writes:[],copies:[],snapshot:JSON.stringify(tables),
      session(){return {access_token:'fictional-token',user:{id:'user-a'}};},
      query(table){
        const q={then(resolve,reject){return Promise.resolve({data:tables[table]||[],error:null}).then(resolve,reject);}};
        for(const key of ['select','eq','in','order','limit','gte','lte','maybeSingle','single','is','not'])q[key]=()=>q;
        for(const key of ['insert','update','delete','upsert'])q[key]=()=>{fixture.writes.push({table,method:key});throw Error('Unexpected table write');};
        return q;
      },
      mount(kind){this.root ||= createRoot(document.getElementById('root'));this.root.render(<MemoryRouter><ThemeProvider><CoachProvider><ClientPrivacyProvider><div style={{position:'fixed',top:0,right:0,zIndex:10000,background:'white'}}><ClientPrivacyToggle/></div><main style={{paddingTop:50}}>{({notifications:<Notifications/>,outbox:<Outbox/>,money:<MoneyTracker/>,courses:<Packages/>,templates:<MessageTemplates/>,aftercare:<Aftercare/>,expenses:<Expenses/>,analytics:<Analytics/>})[kind]}</main></ClientPrivacyProvider></CoachProvider></ThemeProvider></MemoryRouter>);},
    };
    window.fetch=async(input,options={})=>{
      const path=new URL(String(input),location.origin).pathname,method=options.method||'GET';fixture.requests.push({path,method});
      if(method!=='GET'){fixture.writes.push({path,method});throw Error('Unexpected request write '+path);}
      if(path==='/api/outbound/pending')return json({pending});
      if(path==='/api/escalations')return json({escalations:[]});
      if(path==='/api/money/reports')return json({revenue:{this_month_cents:3000},rebooking_rate:{pct:75},no_show_rate:{pct:0},insight:secret+' money insight'});
      if(path==='/api/money/year-to-date')return json({current:amount,previous:{...amount,tax_year:'2025/26'}});
      if(path==='/api/recurring-expenses')return json({recurring:[{id:'recurring-a',vendor:secret+' standing cost',description:secret+' recurring note',category:'rent',amount_cents:500,frequency:'monthly',day_of_month:1,next_due_date:today,active:true}]});
      if(path==='/api/money/ledger')return json({rows:[{id:'ledger-a',kind:'income',description:secret+' ledger detail',category:'payment',amount_cents:3000,running_total_cents:3000,date:today}],summary:{running_total_cents:3000,income_cents:3000,expenses_cents:0,row_count:1,by_category:{}},tax_years:['2026/27'],page:1,page_size:50,total_rows:1,has_more:false});
      throw Error('Unexpected request '+path);
    };
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>fixture.copies.push(text)},configurable:true});
    window.alert=text=>{throw Error('Unexpected alert '+text);};
    window.confirm=text=>{throw Error('Unexpected native confirmation '+text);};
  `},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outfile:'fixture.js',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'},
  plugins:[{name:'privacy-fixtures',setup(b){
    b.onResolve({filter:/\/lib\/(supabase|config|storage|native)\.js$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
      'config.js':'export const API_BASE="";',
      'supabase.js':`export const useBeautician=()=>({beautician:fixture.owner,loading:false});export const fetchRowsStrict=async table=>fixture.tables[table]||[];export const fetchRows=fetchRowsStrict;export const supabase={auth:{getSession:async()=>({data:{session:fixture.session()}}),refreshSession:async()=>({data:{session:fixture.session()}})},from:table=>fixture.query(table)};export const insertRow=(...a)=>{fixture.writes.push(a);throw Error('Unexpected insert');};export const updateRow=insertRow;export const deleteRow=insertRow;`,
      'storage.js':'export const PRIVATE_BUCKET="fixture";export const objectPath=()=>"fixture";export const signedUrlMap=async()=>({});export async function uploadFile(){throw Error("Unexpected upload");}',
      'native.js':'export const hapticTap=()=>{};export const hapticSuccess=()=>{};',
    }[path]}));
  }}],
});
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
const server=http.createServer((req,res)=>{
  res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html');
  res.end(req.url==='/fixture.js'?js:'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await launch();
let checks=0;
try {
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const start=async(kind,hidden=false)=>{await page.goto(origin);await page.evaluate(({kind,hidden})=>{localStorage.setItem('florrie:hide-client-details:v1',String(hidden));fixture.mount(kind);},{kind,hidden});};
  const eye=()=>page.getByRole('button',{name:'Hide client details',exact:true});
  const conceal=async()=>{await eye().click();await page.waitForFunction(()=>document.querySelector('[aria-label="Hide client details"]').getAttribute('aria-pressed')==='true');};
  const reveal=async()=>{await eye().click();await page.waitForFunction(()=>document.querySelector('[aria-label="Hide client details"]').getAttribute('aria-pressed')==='false');};
  const absent=async()=>{
    const rendered=await page.locator('body').evaluate(body=>body.outerHTML+'\n'+[...body.querySelectorAll('input,textarea,select')].map(el=>el.value).join('\n'));
    assert.ok(!rendered.includes('SECONDARY_PRIVATE_SENTINEL'),'Private name, prose, attribute or field value leaked');
    assert.ok(!rendered.includes('447700900123'),'Private telephone link or value leaked');
  };
  const intact=async()=>{
    assert.deepEqual(await page.evaluate(()=>fixture.writes),[],'Changing display privacy must not write or send');
    assert.deepEqual(await page.evaluate(()=>fixture.copies),[],'Changing display privacy must not copy');
    assert.equal(await page.evaluate(()=>JSON.stringify(fixture.tables)===fixture.snapshot),true,'Underlying records were altered');
  };

  await start('notifications');await page.getByText('SECONDARY_PRIVATE_SENTINEL booked',{exact:true}).waitFor();
  await conceal();await absent();await page.getByRole('heading',{name:'Notifications',exact:true}).waitFor();await reveal();await page.getByText('SECONDARY_PRIVATE_SENTINEL booked',{exact:true}).waitFor();await intact();checks++;

  await start('outbox');await page.getByRole('textbox',{name:'Message text',exact:true}).first().fill('SECONDARY_PRIVATE_SENTINEL edited draft');
  await conceal();await absent();assert.equal(await page.getByRole('textbox',{name:'Message text',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Send it',exact:true}).first().isDisabled(),true);
  await reveal();assert.equal(await page.getByRole('textbox',{name:'Message text',exact:true}).first().inputValue(),'SECONDARY_PRIVATE_SENTINEL edited draft');await intact();checks++;
  await page.getByRole('button',{name:'Review one by one',exact:true}).click();await conceal();await absent();
  assert.equal(await page.getByRole('button',{name:'Yes, send',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Yes, send',exact:true}).evaluate(button=>{const card=button.parentElement.previousElementSibling.lastElementChild;card.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[new Touch({identifier:1,target:card,clientX:20,clientY:100})]}));card.dispatchEvent(new TouchEvent('touchend',{bubbles:true,changedTouches:[new Touch({identifier:1,target:card,clientX:240,clientY:100})]}));});
  await page.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);await intact();checks++;

  await start('money');await page.getByText('SECONDARY_PRIVATE_SENTINEL',{exact:true}).waitFor();await conceal();await absent();assert.doesNotMatch(await page.locator('main').innerText(), /£(?:30|25|5)(?:\.00)?\b/, 'Money totals are hidden');await reveal();await page.getByText('SECONDARY_PRIVATE_SENTINEL',{exact:true}).waitFor();checks++;
  await page.getByRole('button',{name:'Ledger',exact:true}).click();await page.getByText('SECONDARY_PRIVATE_SENTINEL ledger detail',{exact:true}).waitFor();await conceal();await absent();assert.equal(await page.getByRole('button',{name:/Export.*CSV/}).isDisabled(),true);await reveal();await page.getByText('SECONDARY_PRIVATE_SENTINEL ledger detail',{exact:true}).waitFor();await intact();checks++;
  await page.getByRole('button',{name:'Expenses',exact:true}).first().click();await page.getByText('SECONDARY_PRIVATE_SENTINEL vendor',{exact:true}).waitFor();
  await page.getByText('SECONDARY_PRIVATE_SENTINEL vendor',{exact:true}).click({button:'right'});await page.getByText('Delete this expense?',{exact:true}).waitFor();await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Delete',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Keep it',exact:true}).click();assert.equal(await page.getByText('Delete this expense?',{exact:true}).count(),0);await reveal();await intact();checks++;
  await page.getByRole('button',{name:'Edit this cost',exact:true}).click();await page.getByRole('textbox').filter({hasNot:page.locator('textarea')}).first().waitFor();await conceal();await absent();await page.getByRole('button',{name:'Cancel',exact:true}).click();await intact();checks++;

  await start('courses');await page.getByRole('button',{name:/^Students/}).first().click();await page.getByText('SECONDARY_PRIVATE_SENTINEL student',{exact:true}).click();await page.getByRole('link',{name:'Email',exact:true}).waitFor();await conceal();await absent();assert.doesNotMatch(await page.locator('main').innerText(), /£(?:450|100|350)(?:\.00)?\b/, 'Course prices, paid amounts and balances are hidden');await page.getByText('Deposit paid',{exact:true}).first().waitFor();assert.equal(await page.locator('a[href^="mailto:"],a[href^="tel:"],a[href^="https://wa.me/"]').count(),0);assert.equal(await page.getByRole('button',{name:'Paid in full',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Remove',exact:true}).isDisabled(),true);await reveal();await page.getByText('SECONDARY_PRIVATE_SENTINEL student',{exact:true}).waitFor();await page.getByRole('link',{name:'Email',exact:true}).waitFor();await intact();checks++;

  await start('templates');await page.getByText('SECONDARY_PRIVATE_SENTINEL template',{exact:true}).click();await page.getByRole('button',{name:'Preview',exact:true}).click();await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Delete',exact:true}).isDisabled(),true);await reveal();await page.getByText('SECONDARY_PRIVATE_SENTINEL stored message',{exact:true}).first().waitFor();await page.getByRole('button',{name:'+ New',exact:true}).click();await page.getByPlaceholder('Template name',{exact:true}).fill('SECONDARY_PRIVATE_SENTINEL unsaved template');await conceal();await absent();await reveal();assert.equal(await page.getByPlaceholder('Template name',{exact:true}).inputValue(),'SECONDARY_PRIVATE_SENTINEL unsaved template');await intact();checks++;

  await start('aftercare');await page.getByText('SECONDARY_PRIVATE_SENTINEL instruction title',{exact:true}).waitFor();await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByText('SECONDARY_PRIVATE_SENTINEL care note',{exact:true}).waitFor();await conceal();await absent();await page.getByRole('button',{name:'×',exact:true}).click();await reveal();await page.getByRole('button',{name:'+ New Care Card',exact:true}).click();await page.getByPlaceholder('A warm message in your voice...',{exact:true}).fill('SECONDARY_PRIVATE_SENTINEL unsaved note');await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Save Card',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Cancel',exact:true}).click();await intact();checks++;

  await start('expenses');await page.getByRole('heading',{name:'Expenses',exact:true}).waitFor();await conceal();assert.doesNotMatch(await page.locator('main').innerText(), /£5(?:\.00)?\b/, 'Expense totals are hidden');assert.equal(await page.getByRole('button',{name:/^Export.*CSV/}).isDisabled(),true);await reveal();await page.getByRole('button',{name:'List',exact:true}).click();await page.getByText('SECONDARY_PRIVATE_SENTINEL vendor',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Edit',exact:true}).first().click();await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Update Expense',exact:true}).isDisabled(),true);await reveal();assert.equal(await page.getByPlaceholder('e.g. Sally Beauty',{exact:true}).inputValue(),'SECONDARY_PRIVATE_SENTINEL vendor');await intact();checks++;

  await start('analytics');await page.getByText(/SECONDARY_PRIVATE_SENTINEL Client is your top client/).waitFor();await conceal();await absent();await page.getByText('Patterns to explore',{exact:true}).waitFor();await reveal();await page.getByText(/SECONDARY_PRIVATE_SENTINEL Client is your top client/).waitFor();await intact();checks++;

  await start('notifications',true);await page.getByRole('heading',{name:'Notifications',exact:true}).waitFor();await page.waitForFunction(()=>fixture.requests.some(r=>r.path==='/api/outbound/pending'));await absent();assert.equal(await eye().getAttribute('aria-pressed'),'true');await intact();checks++;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:checks,pages:8,providerRequests:0,checks:'Actual secondary pages; hidden names/contact/notes/forms, retained edits, disabled exports/sends, closable overlays, initial privacy state and zero unintended writes'}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
