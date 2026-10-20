// Actual owner/public course pages with fictional records. All provider traffic is intercepted.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const output = process.env.FLORRIE_VISUAL_OUT;
if (output) mkdirSync(output, { recursive: true });
const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222',
  full: '33333333-3333-4333-8333-333333333333', past: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555', group: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const course = (id = ids.a, patch = {}) => ({
  id, beautician_id: 'fictional-owner', name: 'Brow training', description: 'A fictional practical training day.',
  date: '2026-11-02', start_time: '09:30', location: 'Fictional Training Studio', duration: 'Full day (7hrs)',
  price: 450, deposit: 0, max_students: 4, enrolled: 0, spots_left: 4, is_full: false, status: 'active',
  includes: ['certificate', 'manual'], created_at: '2026-10-20T09:00:00Z', ...patch,
});
const dates = [course(ids.a, { course_group_id: ids.group }), course(ids.b, {
  course_group_id: ids.group, date: '2026-11-09', start_time: '10:00', location: 'Second Training Studio',
})];
const trainer = { id: 'fictional-owner', auth_id: 'fictional-user', business_name: 'Fictional Brow Studio',
  booking_slug: 'fictional', timezone: 'Europe/London', stripe_ready: false };
const publicData = (rows = dates, anchor = rows[0]) => ({
  course: anchor, dates: rows, date_selection_required: rows.length > 1, beautician: trainer,
});
const store = `
export const useBeautician=()=>({beautician:window.fixture.owner,loading:false});
function query(table){
 const s=window.fixture, filters=[],q={table,method:'select',body:null,singleRow:false};
 const api={
  select(){return api;},order(){return api;},limit(){return api;},abortSignal(){return api;},
  eq(key,value){filters.push([key,value]);return api;},in(key,value){filters.push([key,value]);return api;},
  insert(body){q.method='insert';q.body=body;return api;},
  update(body){q.method='update';q.body=body;return api;},
  delete(){q.method='delete';return api;},single(){q.singleRow=true;return api;},
  then(resolve,reject){return execute().then(resolve,reject);}
 };
 async function execute(){
  const rows=table==='courses'?s.courses:s.enrollments;
  if(!['courses','course_enrollments'].includes(table))throw Error('Unexpected fixture table '+table);
  if(q.method==='select')return s.failOwnerRead?{data:null,error:{message:'Synthetic read failure'}}:{data:rows.filter(row=>filters.every(([key,value])=>Array.isArray(value)?value.includes(row[key]):row[key]===value)),error:null};
  s.writes.push({...q,filters});
  if(s.holdOwnerWrite)await new Promise(resolve=>{s.releaseOwnerWrite=resolve;});
  if(s.failOwnerWrite)return {data:null,error:{message:'Synthetic save failure'}};
  if(q.method==='insert'){
   const added=(Array.isArray(q.body)?q.body:[q.body]).map((row,index)=>({id:'created-'+index,enrolled:0,created_at:'2026-10-20T10:00:00Z',...row}));
   if(added.some(row=>rows.some(saved=>saved.id===row.id)))return {data:null,error:{code:'23505',message:'Duplicate id'}};
   rows.push(...added);if(s.loseOwnerResponse)return {data:null,error:{message:'Network connection lost'}};return {data:q.singleRow?added[0]:added,error:null};
  }
  const matching=rows.filter(row=>filters.every(([key,value])=>row[key]===value));
  if(q.method==='update'){matching.forEach(row=>Object.assign(row,q.body));return {data:q.singleRow?matching[0]:matching,error:null};}
  if(q.method==='delete'){for(const row of matching)rows.splice(rows.indexOf(row),1);return {data:null,error:null};}
 }
 return api;
}
export const supabase={from:query,auth:{getSession:async()=>({data:{session:{access_token:'fictional-token',user:{id:'fictional-user'}}}})},rpc:async(name,args)=>{
 const s=window.fixture;s.writes.push({method:'rpc',name,args});
 if(s.failOwnerWrite)return {data:null,error:{message:'Synthetic save failure'}};
 if(name!=='add_course_dates')throw Error('Unexpected RPC '+name);
 const anchor=s.courses.find(row=>row.id===args.p_course_id);
 if(!anchor)throw Error('Missing fixture anchor');
 const group=anchor.course_group_id||anchor.id;anchor.course_group_id=group;
 const added=args.p_dates.map(row=>({...anchor,...row,course_group_id:group,enrolled:0,status:'active'}));
 s.courses.push(...added);return {data:[anchor,...added],error:null};
}};
`;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom';
    import TrainingBooking from './src/pages/TrainingBooking.jsx';import Packages from './src/pages/Packages.jsx';
    import {ThemeProvider} from './src/lib/theme.jsx';
    const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const s=window.fixture={owner:${JSON.stringify(trainer)},courses:[],enrollments:[],public:{},requests:[],writes:[],checkout:[],holdGets:[],holdPosts:[],failOwnerRead:false,failOwnerWrite:false};
    function Harness(){s.navigate=useNavigate();return <Routes><Route path="/courses" element={<Packages/>}/><Route path="/training/:slug/:courseId" element={<TrainingBooking/>}/></Routes>;}
    s.render=()=>s.root.render(<ThemeProvider><BrowserRouter><Harness/></BrowserRouter></ThemeProvider>);
    s.mount=()=>{s.root=createRoot(document.getElementById('root'));s.render();};
    window.fetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin),method=String(options.method||'GET').toUpperCase();
      const body=options.body?JSON.parse(options.body):null;
      s.requests.push({path:url.pathname,method,body});
      if(!url.pathname.startsWith('/api/courses/'))throw Error('Unexpected fixture fetch '+url.pathname);
      const id=url.pathname.split('/')[4],record=s.public[id];
      if(!record)return json({error:'Course not found'},404);
      const response=()=>method==='GET'?json(record.data,record.status||200):json(record.post||{confirmed:true},record.postStatus||200);
      const holds=method==='GET'?s.holdGets:s.holdPosts;
      if(holds.includes(id)){
        return await new Promise((resolve,reject)=>{
          s['release'+(method==='GET'?'Get':'Post')+'_'+id]=()=>resolve(response());
          options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
        });
      }
      return response();
    };
  ` },
  bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'fictional-courses', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config)\.js$/ }, a => ({ path: basename(a.path), namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ loader: 'js', contents: a.path === 'supabase.js' ? store : 'export const API_BASE="";' }));
  } }],
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const tokens = [...readFileSync(join(root, 'index.html'), 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const styles = readFileSync(join(root, 'src/index.css'), 'utf8').replace(/@import\s+url\([^;]+;/g, '');
const fontDir = process.env.VISUAL_FONT_DIR;
const fontCss = fontDir && existsSync(join(fontDir, 'fonts.css')) ? readFileSync(join(fontDir, 'fonts.css'), 'utf8') : '';
const preview = process.env.KEEP_TRAINING_PREVIEW === '1';
const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(js); }
  if (path.startsWith('/fonts/') && fontDir && /^\/fonts\/[a-zA-Z0-9._-]+$/.test(path)) {
    const file = join(fontDir, basename(path));
    if (existsSync(file)) { res.setHeader('content-type', 'font/woff2'); return res.end(readFileSync(file)); }
  }
  res.setHeader('content-type', 'text/html');
  const reviewing = preview && new URL(req.url || '/', 'http://localhost').searchParams.get('preview') === '1';
  const previewNote = reviewing
    ? `<div style="padding:12px 16px;background:#F6E7EC;font:12px system-ui;color:#574A42">Preview · Fictional salon data · Changes stay in this page. <a href="/courses?preview=1">Trainer</a> · <a href="/training/fictional/${ids.a}?preview=1">Student</a></div>` : '';
  const previewSetup = reviewing
    ? `<script>Object.assign(window.fixture,${JSON.stringify({ courses: dates, public: {
      [ids.a]: { data: publicData() }, [ids.b]: { data: publicData(dates, dates[1]) },
    } })});window.fixture.mount();</script>` : '';
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + tokens + styles + fontCss + 'body{margin:0}#root{max-width:1080px;margin:0 auto}</style>' + previewNote
    + '<div id="root"></div><script src="/fixture.js"></script>' + previewSetup + '</html>');
});
await new Promise(resolve => server.listen(Number(process.env.TRAINING_PREVIEW_PORT || 0), '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
let passed = 0;
async function fixture({ path = `/training/fictional/${ids.a}`, records = { [ids.a]: { data: publicData() } },
  courses = [], enrollments = [], width = 390, setup, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], external = [], stripe = [];
  page.setDefaultTimeout(10000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === 'https://checkout.stripe.com') {
      stripe.push(url.href);
      return route.fulfill({ contentType: 'text/html', body: '<p>Fictional payment processor. No payment was made.</p>' });
    }
    external.push(url.origin); return route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  if (clock) await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
  else await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto(origin + path);
  await page.evaluate(({ records, courses, enrollments }) => {
    Object.assign(window.fixture, { public: records, courses, enrollments });
  }, { records, courses, enrollments });
  if (setup) await page.evaluate(setup);
  await page.evaluate(() => fixture.mount());
  return { page, context, stripe, close: async () => {
    assert.deepEqual(errors, [], 'No page errors'); assert.deepEqual(external, [], 'No external provider traffic');
    await context.close();
  } };
}
const posts = page => page.evaluate(() => fixture.requests.filter(r => r.method === 'POST'));
const writes = page => page.evaluate(() => fixture.writes);
const bookButton = page => page.getByRole('button', { name: /^(Book my place|Choose a date to book|Booking your place)/ });
async function details(page) {
  await page.getByPlaceholder('Your name').fill('Fictional Student');
  await page.getByPlaceholder('you@email.com').fill('student@example.test');
}
async function fit(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, actual: document.documentElement.scrollWidth }));
  assert.ok(size.actual <= size.viewport, `No horizontal overflow: ${JSON.stringify(size)}`);
  assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Plus Jakarta Sans/);
}
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  if (output) await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
}
const pass = message => { passed++; console.log('PASS: ' + message); };

try {
  // A legacy link remains bookable without creating or assigning a replacement date.
  {
    const legacy = course();
    const { page, close } = await fixture({ records: { [ids.a]: { data: { course: legacy, beautician: trainer } } } });
    await page.getByRole('heading', { name: 'Brow training', exact: true }).waitFor();
    await details(page); await bookButton(page).click();
    await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    assert.equal((await posts(page))[0].body.selected_course_id, ids.a);
    assert.match(await page.locator('body').innerText(), /Monday,? 2 November 2026/);
    await close(); pass('Legacy single-date link enrols the original occurrence and shows its date.');
  }
  // Multiple dates require a conscious choice; the request and confirmation use the chosen occurrence.
  for (const width of [390, 1024]) {
    const { page, close } = await fixture({ width });
    const first = page.getByRole('radio', { name: /Monday,? 2 November 2026/ });
    const second = page.getByRole('radio', { name: /Monday,? 9 November 2026/ });
    await second.waitFor(); assert.equal(await first.isChecked(), false); assert.equal(await second.isChecked(), false);
    await details(page); assert.equal(await bookButton(page).isDisabled(), true);
    assert.deepEqual(await posts(page), []);
    await second.check(); assert.equal(await first.isChecked(), false); assert.equal(await second.isChecked(), true);
    await fit(page); await shot(page, `training-date-choice-${width}`);
    await bookButton(page).click();
    await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    const sent = await posts(page); assert.equal(sent.length, 1); assert.equal(sent[0].body.selected_course_id, ids.b);
    assert.equal(sent[0].body.email, 'student@example.test');
    const text = await page.locator('body').innerText();
    assert.match(text, /Monday,? 9 November 2026/); assert.match(text, /Second Training Studio/);
    assert.doesNotMatch(text, /Monday,? 2 November 2026/);
    await shot(page, `training-confirmed-${width}`);
    await close(); pass(`${width}px: explicit choice determines enrolment, location and confirmation.`);
  }
  {
    const full = course(ids.full, { course_group_id: ids.group, date: '2026-11-16', enrolled: 4, spots_left: 0, is_full: true });
    const past = course(ids.past, { course_group_id: ids.group, date: '2020-01-01', in_the_past: true });
    const { page, close } = await fixture({ records: { [ids.a]: { data: publicData([dates[0], full, past]) } } });
    await page.getByRole('radio', { name: /Monday,? 2 November 2026/ }).waitFor();
    const blocked = page.getByRole('radio', { name: /16 November|1 January/ });
    for (const radio of await blocked.all()) assert.equal(await radio.isDisabled(), true);
    await details(page); assert.equal(await bookButton(page).isDisabled(), true);
    await page.getByRole('radio', { name: /Monday,? 2 November 2026/ }).check();
    await bookButton(page).click(); await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    assert.equal((await posts(page))[0].body.selected_course_id, ids.a);
    await close(); pass('Full/past dates cannot be selected; the remaining offered date still needs a choice.');
  }
  {
    const { page, close, stripe } = await fixture({ records: { [ids.a]: {
      data: publicData(dates.map(row => ({ ...row, deposit: 90 }))),
      post: { checkout_url: 'https://checkout.stripe.com/c/pay/fictional-only' },
    } } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check();
    await details(page);
    const sent = page.waitForURL('https://checkout.stripe.com/**'); await bookButton(page).click(); await sent;
    assert.equal(stripe.length, 1);
    await close(); pass('Selected-date booking reaches an intercepted Stripe checkout; no real payment request.');
  }
  {
    const { page, close } = await fixture({ path: `/training/fictional/${ids.b}?cancelled=true`,
      records: { [ids.b]: { data: publicData(dates, dates[1]) } } });
    await page.getByText(/card payment was cancelled/i).waitFor();
    assert.equal(await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).isChecked(), true);
    assert.equal(await page.getByRole('radio', { name: /Monday,? 2 November 2026/ }).isChecked(), false);
    assert.deepEqual(await posts(page), []);
    await details(page); await bookButton(page).click(); await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    assert.equal((await posts(page))[0].body.selected_course_id, ids.b);
    await close(); pass('Canceled checkout retains the actual chosen date and never silently rebooks.');
  }
  {
    const { page, close } = await fixture({ path: `/training/fictional/${ids.b}?enrolled=true&name=Fictional`,
      records: { [ids.b]: { data: publicData(dates, dates[1]) } } });
    await page.getByRole('heading', { name: /Payment submitted/i }).waitFor();
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /deposit is paid|spot is secured|You're in!/i);
    assert.match(text, /9 November/); assert.deepEqual(await posts(page), []);
    await close(); pass('A return URL alone cannot claim proven payment; chosen course details remain visible.');
  }
  {
    const data = publicData();
    const { page, close } = await fixture({ records: { [ids.a]: { data, postStatus: 409, post: { error: 'That date has just filled up. Please choose another.' } } } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check(); await details(page);
    await bookButton(page).click(); await page.getByText(/That date has just filled up/).waitFor();
    assert.equal(await page.getByPlaceholder('Your name').inputValue(), 'Fictional Student');
    assert.equal(await bookButton(page).isEnabled(), true);
    assert.equal(await page.getByRole('heading', { name: /enrolled/i }).count(), 0);
    await close(); pass('A date filling up during submit retains the form and reports failure without false confirmation.');
  }
  {
    const secondCourse = course(ids.other, { name: 'Different course', date: '2026-12-01' });
    const { page, close } = await fixture({ records: {
      [ids.a]: { data: publicData() }, [ids.other]: { data: publicData([secondCourse]) },
    }, setup: () => { fixture.holdGets = ['11111111-1111-4111-8111-111111111111']; } });
    await page.waitForFunction(() => fixture.requests.length === 1);
    await page.evaluate(id => fixture.navigate('/training/fictional/' + id), ids.other);
    await page.getByRole('heading', { name: 'Different course', exact: true }).waitFor();
    await page.evaluate(id => fixture['releaseGet_' + id](), ids.a);
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Different course');
    assert.equal(await page.getByRole('radio').count(), 0);
    await details(page); await bookButton(page).click(); await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    assert.equal((await posts(page))[0].body.selected_course_id, ids.other);
    await close(); pass('A slow previous course load cannot overwrite or submit the new course.');
  }
  {
    const secondCourse = course(ids.other, { name: 'Different course', date: '2026-12-01' });
    const { page, close } = await fixture({ records: {
      [ids.a]: { data: publicData(), post: { checkout_url: 'https://checkout.stripe.com/c/pay/stale' } },
      [ids.other]: { data: publicData([secondCourse]) },
    }, setup: () => { fixture.holdPosts = ['11111111-1111-4111-8111-111111111111']; } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check(); await details(page);
    await bookButton(page).click(); await page.waitForFunction(() => fixture.requests.some(r => r.method === 'POST'));
    await page.evaluate(id => fixture.navigate('/training/fictional/' + id), ids.other);
    await page.getByRole('heading', { name: 'Different course', exact: true }).waitFor();
    await page.evaluate(id => fixture['releasePost_' + id](), ids.a);
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Different course');
    assert.match(page.url(), new RegExp(ids.other));
    assert.equal(await page.getByRole('heading', { name: /enrolled/i }).count(), 0);
    assert.equal(await page.getByPlaceholder('Your name').inputValue(), '');
    await close(); pass('A stale booking response cannot redirect or confirm after changing courses.');
  }
  {
    const { page, close } = await fixture({ clock: true, setup: () => { fixture.holdGets = ['11111111-1111-4111-8111-111111111111']; } });
    await page.getByText('Loading course...', { exact: true }).waitFor();
    await page.clock.runFor(31000);
    await page.getByRole('button', { name: /try again|retry/i }).waitFor();
    await page.evaluate(() => { fixture.holdGets = []; });
    await page.getByRole('button', { name: /try again|retry/i }).click();
    await page.getByRole('heading', { name: 'Brow training', exact: true }).waitFor();
    await close(); pass('An unresponsive course load times out and can be retried.');
  }
  {
    const { page, close } = await fixture({ clock: true, setup: () => { fixture.holdPosts = ['11111111-1111-4111-8111-111111111111']; } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check(); await details(page);
    await bookButton(page).evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => fixture.requests.some(r => r.method === 'POST'));
    assert.equal((await posts(page)).length, 1, 'Double activation sends one enrolment');
    assert.equal(await page.getByRole('radio', { name: /Monday,? 2 November 2026/ }).isDisabled(), true);
    assert.equal(await page.getByPlaceholder('Your name').isDisabled(), true);
    await page.clock.runFor(21000);
    await page.getByRole('alert').filter({ hasText: /check whether your booking completed/i }).waitFor();
    assert.equal(await page.getByPlaceholder('Your name').inputValue(), 'Fictional Student');
    assert.equal(await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).isChecked(), true);
    assert.equal(await bookButton(page).isEnabled(), true);
    assert.equal((await posts(page)).length, 1, 'No automatic retry of uncertain payment/enrolment');
    await close(); pass('Duplicate submission is blocked, chosen date locks during submit, and uncertain completion never auto-retries.');
  }
  {
    const full = dates.map(row => ({ ...row, is_full: true, spots_left: 0, enrolled: 4 }));
    const { page, close } = await fixture({ records: { [ids.a]: { data: publicData(full) } } });
    await page.getByText('These course dates are full', { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('Your name').count(), 0);
    assert.equal(await bookButton(page).count(), 0);
    assert.deepEqual(await posts(page), []);
    await close(); pass('No available dates produces an honest full state with no enrolment form.');
  }
  {
    const { page, close } = await fixture({ records: { [ids.a]: { data: publicData([], dates[0]) } } });
    await page.getByText('No dates are available to book', { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('Your name').count(), 0);
    assert.equal(await bookButton(page).count(), 0);
    assert.equal(await page.getByText('These course dates are full', { exact: true }).count(), 0);
    assert.deepEqual(await posts(page), []);
    await close(); pass('An empty offered-date list never silently falls back to enrolment on the anchor.');
  }
  {
    const { page, close } = await fixture({ records: { [ids.a]: { data: { ...publicData([dates[0]]), date_selection_required: true } } } });
    const date = page.getByRole('radio', { name: /Monday,? 2 November 2026/ });
    await date.waitFor(); assert.equal(await date.isChecked(), false);
    await details(page); assert.equal(await bookButton(page).isDisabled(), true);
    // The single remaining option collapses into the selected course summary.
    await date.click(); await bookButton(page).click();
    await page.getByRole('heading', { name: /enrolled/i }).waitFor();
    assert.equal((await posts(page))[0].body.selected_course_id, ids.a);
    await close(); pass('A shared course with only one remaining offered date still respects explicit selection.');
  }
  for (const [name, post, message] of [
    ['wrong date', { confirmed: true, selected_course_id: ids.a }, /could not confirm your chosen date/i],
    ['untrusted checkout', { checkout_url: 'https://notstripe.com/checkout' }, /could not open the card payment/i],
    ['missing confirmation', { accepted: true }, /could not confirm your place/i],
  ]) {
    const { page, close } = await fixture({ records: { [ids.a]: { data: publicData(), post } } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check(); await details(page);
    await bookButton(page).click(); await page.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(await page.getByRole('heading', { name: /enrolled/i }).count(), 0);
    assert.match(page.url(), new RegExp(ids.a));
    assert.equal(await page.getByPlaceholder('Your name').inputValue(), 'Fictional Student');
    await close(); pass(`Public ${name} response cannot become a false booking confirmation.`);
  }
  {
    const priced = [dates[0], { ...dates[1], price: 450.75, deposit: 90.5 }];
    const { page, close } = await fixture({ records: { [ids.a]: {
      data: { ...publicData(priced), beautician: { ...trainer, stripe_ready: true } },
    } } });
    await page.getByRole('radio', { name: /Monday,? 9 November 2026/ }).check();
    await page.getByRole('button', { name: 'Book my place, pay £90.50 deposit', exact: true }).waitFor();
    await page.getByText('£450.75', { exact: true }).waitFor();
    await page.getByText(/£360.25 is due on the day/).waitFor();
    assert.deepEqual(await posts(page), []);
    await close(); pass('Selected-date price, deposit and balance retain exact pence without rounding the charge.');
  }
  // Owner dates are explicit saved occurrences, never a list flattened into one existing date.
  {
    const { page, close } = await fixture({ path: '/courses' });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('Fictional multi-date course');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-02');
    await page.getByLabel('Start time 1', { exact: true }).fill('09:30');
    await page.getByRole('button', { name: '+ Add another date', exact: true }).click();
    await page.getByLabel('Date 2', { exact: true }).fill('2026-11-09');
    await page.getByLabel('Start time 2', { exact: true }).fill('10:00');
    await fit(page); await shot(page, 'training-owner-multiple-dates-390');
    assert.deepEqual(await writes(page), [], 'Editing dates must not write until Save');
    await page.evaluate(() => { fixture.failOwnerWrite = true; });
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.getByText(/Could not confirm the course was saved/).waitFor();
    assert.equal(await page.getByLabel('Date 2', { exact: true }).inputValue(), '2026-11-09');
    assert.equal(await page.evaluate(() => fixture.courses.length), 0);
    await page.evaluate(() => { fixture.failOwnerWrite = false; });
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.getByText('Fictional multi-date course', { exact: true }).waitFor();
    const attempts = await writes(page);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].method, 'insert');
    assert.equal(attempts[1].body.length, 2, 'All dates are in one atomic insert request');
    assert.deepEqual(attempts[1].body.map(row => row.date), ['2026-11-02', '2026-11-09']);
    assert.ok(attempts[1].body[0].course_group_id);
    assert.equal(attempts[1].body[0].course_group_id, attempts[1].body[1].course_group_id);
    assert.equal(new Set(attempts[1].body.map(row => row.id)).size, 2);
    assert.deepEqual(attempts[0].body, attempts[1].body, 'Retry must reuse the same occurrence identities');
    assert.equal(await page.getByText('Fictional multi-date course', { exact: true }).count(), 1, 'One course group card');
    await fit(page); await shot(page, 'training-owner-course-dates-390');
    await close(); pass('Owner multi-date create is one atomic save; failure retains dates and stable identities; one grouped card.');
  }
  {
    const held = { id: 'held-student', beautician_id: trainer.id, course_id: ids.a, name: 'Fictional Student', email: 'student@example.test',
      payment_status: 'deposit_paid', amount_paid_cents: 9000, stripe_payment_intent_id: 'pi_fictional' };
    const { page, close } = await fixture({ path: '/courses', courses: [course(ids.a, { enrolled: 1 })], enrollments: [held] });
    await page.getByRole('button', { name: /Edit date|^Edit$/ }).click();
    assert.equal(await page.getByLabel('Date 1', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Start time 1', { exact: true }).isDisabled(), true);
    assert.deepEqual(await writes(page), []);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await page.getByRole('button', { name: '+ Add dates', exact: true }).click();
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-16');
    await page.getByLabel('Start time 1', { exact: true }).fill('11:00');
    await page.getByRole('button', { name: '+ Add another date', exact: true }).click();
    await page.getByLabel('Date 2', { exact: true }).fill('2026-11-23');
    await page.getByRole('button', { name: 'Save dates', exact: true }).click();
    await page.waitForFunction(() => fixture.courses.length === 3);
    const requests = await writes(page);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'rpc');
    assert.equal(requests[0].name, 'add_course_dates'); assert.equal(requests[0].args.p_course_id, ids.a);
    assert.deepEqual(requests[0].args.p_dates.map(row => row.date), ['2026-11-16', '2026-11-23']);
    assert.deepEqual(await page.evaluate(() => fixture.enrollments), [held], 'Booked student/payment record unchanged');
    assert.equal(await page.evaluate(() => fixture.courses[0].date), '2026-11-02');
    await close(); pass('Booked date/time are protected; adding offered dates preserves existing students and payments.');
  }
  {
    const { page, close } = await fixture({ path: '/courses' });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('Unconfirmed course');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.getByText('Unconfirmed course', { exact: true }).waitFor();
    const [write] = await writes(page);
    assert.equal(Array.isArray(write.body), false, 'Legacy single-date insert remains compatible');
    assert.equal(write.body.date, null); assert.equal(write.body.start_time, null);
    assert.equal('course_group_id' in write.body, false);
    await page.getByText('Date to be confirmed', { exact: true }).waitFor();
    await close(); pass('One unconfirmed-date course still saves without requiring the grouping migration.');
  }
  {
    const { page, close } = await fixture({ path: '/courses' });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('Validation course');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-02');
    await page.getByRole('button', { name: '+ Add another date', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Create course', exact: true }).isDisabled(), true);
    await page.getByLabel('Date 2', { exact: true }).fill('2026-11-02');
    await page.getByText(/same date and time twice/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create course', exact: true }).isDisabled(), true);
    await page.getByLabel('Date 2', { exact: true }).fill('2020-01-01');
    await page.getByText(/One of those dates has already passed/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create course', exact: true }).isDisabled(), true);
    assert.deepEqual(await writes(page), []);
    await close(); pass('Owner cannot save incomplete, duplicated or past offered dates.');
  }
  {
    const { page, close } = await fixture({ path: '/courses', courses: dates });
    await page.getByRole('region', { name: 'Brow training', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Brow training', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Close bookings', exact: true }).nth(1).click();
    await page.getByText('Bookings closed', { exact: true }).waitFor();
    const [write] = await writes(page); assert.equal(write.method, 'update');
    assert.deepEqual(write.body, { status: 'draft' });
    assert.ok(write.filters.some(([key, value]) => key === 'id' && value === ids.b));
    assert.equal(await page.evaluate(id => fixture.courses.find(row => row.id === id).status, ids.a), 'active');
    await close(); pass('Closing one date keeps the other offered date open.');
  }
  {
    const { page, close } = await fixture({ path: '/courses', setup: () => { fixture.loseOwnerResponse = true; } });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('Saved despite lost response');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-02');
    await page.getByRole('button', { name: '+ Add another date', exact: true }).click();
    await page.getByLabel('Date 2', { exact: true }).fill('2026-11-09');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.getByText('Saved despite lost response', { exact: true }).waitFor();
    assert.equal((await writes(page)).length, 1);
    assert.equal(await page.evaluate(() => fixture.courses.length), 2);
    assert.equal(await page.getByLabel('Date 1', { exact: true }).count(), 0, 'Recovered save exits the editor');
    await close(); pass('A saved course with a lost response is recovered by exact occurrence IDs without duplicate inserts.');
  }
  {
    const { page, close } = await fixture({ path: '/courses', setup: () => { fixture.holdOwnerWrite = true; } });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('One save at a time');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-02');
    await page.getByRole('button', { name: 'Create course', exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => !!fixture.releaseOwnerWrite);
    assert.equal((await writes(page)).length, 1);
    assert.equal(await page.getByLabel('Date 1', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').isDisabled(), true);
    for (const button of await page.getByRole('button', { name: 'Close', exact: true }).all()) assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => fixture.releaseOwnerWrite());
    await page.getByText('One save at a time', { exact: true }).waitFor();
    await close(); pass('Owner duplicate save is blocked synchronously and the pending form cannot be changed or closed.');
  }
  {
    const { page, close } = await fixture({ path: '/courses', courses: dates,
      setup: () => { fixture.holdOwnerWrite = true; } });
    await page.getByRole('button', { name: '+ New course', exact: true }).click();
    await page.getByPlaceholder('e.g. Ultimate Beginner Lash Course').fill('Old owner pending course');
    await page.getByPlaceholder('750', { exact: true }).fill('450');
    await page.getByLabel('Date 1', { exact: true }).fill('2026-11-02');
    await page.getByRole('button', { name: 'Create course', exact: true }).click();
    await page.waitForFunction(() => !!fixture.releaseOwnerWrite);
    await page.evaluate(() => { fixture.owner = { ...fixture.owner, id: 'second-owner', auth_id: 'second-user' }; fixture.render(); });
    await page.getByText('No courses yet', { exact: true }).waitFor();
    await page.evaluate(() => fixture.releaseOwnerWrite());
    await page.getByText('No courses yet', { exact: true }).waitFor();
    assert.equal(await page.getByText('Old owner pending course', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Brow training', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Date 1', { exact: true }).count(), 0);
    assert.equal((await writes(page)).length, 1);
    await close(); pass('A pending old-owner save cannot reveal courses or reopen a form after switching salons.');
  }
  {
    const { page, close } = await fixture({ path: '/courses', setup: () => { fixture.failOwnerRead = true; } });
    await page.getByText(/Could not load your courses just now/).waitFor();
    assert.equal(await page.getByText('No courses yet', { exact: true }).count(), 0);
    assert.deepEqual(await writes(page), []);
    await close(); pass('Owner load failure is not presented as an empty course list.');
  }
  {
    const pending = { id: 'pending-checkout', beautician_id: trainer.id, course_id: ids.a, name: 'Fictional Checkout',
      email: 'pending@example.test', payment_status: 'unpaid', amount_paid_cents: 0, stripe_payment_intent_id: 'cs_fictional' };
    const { page, close } = await fixture({ path: '/courses', courses: [course()], enrollments: [pending] });
    await page.getByRole('button', { name: 'Edit date', exact: true }).click();
    assert.equal(await page.getByLabel('Date 1', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Start time 1', { exact: true }).isDisabled(), true);
    await page.getByText(/bookings or a checkout in progress/).waitFor();
    assert.deepEqual(await writes(page), []);
    await close(); pass('A pending checkout protects its date/time before a place becomes fully confirmed.');
  }
  console.log(`Training date checks passed: ${passed} groups.`);
} finally {
  await browser.close();
  if (!preview) server.close();
  else console.log(`Fictional training preview: ${origin}/training/fictional/${ids.a}?preview=1`);
}
