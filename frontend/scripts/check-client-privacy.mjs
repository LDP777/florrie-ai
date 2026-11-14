// Privacy preference and concealment contracts, using fictional data only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ClientPrivacyProvider, ClientPrivacyToggle, ClientPrivacyStatus, PrivateText, PrivateSection} from './src/contexts/ClientPrivacyContext.jsx';
function Content() { const [tab,setTab]=React.useState(0); const [draft,setDraft]=React.useState('Private consultation note'); return <>
  <ClientPrivacyToggle/><ClientPrivacyStatus/>
  <button onClick={()=>setTab(n=>n+1)}>Navigate</button><h1>Diary {tab}</h1><p>10:30 · Brow lamination</p>
  <PrivateText title="Priya Secretson" aria-label="Priya Secretson" data-name="Priya Secretson" placeholder="Client">Priya Secretson</PrivateText>
  <PrivateText><a href="mailto:private@example.invalid">private@example.invalid</a></PrivateText>
  <PrivateSection><label>Note<input value={draft} onChange={e=>setDraft(e.target.value)}/></label><img src="/private-avatar.jpg" alt="Priya Secretson"/><button>Save client</button></PrivateSection>
  <div className="unchanged"><PrivateText><strong>Original layout</strong></PrivateText></div>
</> }
createRoot(document.getElementById('root')).render(location.pathname==='/public' ? <Content/> : <ClientPrivacyProvider><Content/></ClientPrivacyProvider>);
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' } });
const css = readFileSync(new URL('../src/styles/client-privacy.css', import.meta.url), 'utf8');
const server = http.createServer((req,res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : `<style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
const secret = /Priya|Secretson|private@example|Private consultation|private-avatar|Edited confidential/;
try {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await launch(existsSync(chrome) ? {executablePath:chrome} : {});
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByRole('heading',{name:'Diary 0'}).waitFor();
  assert.equal(await page.locator('.unchanged > strong').count(),1,'visible mode preserves the original layout');
  await page.getByLabel('Note',{exact:true}).fill('Edited confidential');
  const eye=page.getByRole('button',{name:'Hide client details',exact:true});
  assert.equal(await eye.getAttribute('aria-pressed'),'false');
  await eye.focus();await page.keyboard.press('Space');
  assert.equal(await eye.getAttribute('aria-pressed'),'true');
  assert.equal(await eye.evaluate(e=>e===document.activeElement),true);
  assert.ok(!secret.test(await page.locator('#root').innerHTML()),'secrets removed from DOM, values, URLs and accessible attributes');
  await page.getByText('10:30 · Brow lamination',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save client',exact:true}).count(),0);
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  assert.ok(!secret.test(await page.locator('#root').innerHTML()),'navigation keeps privacy enabled');
  await page.reload();await page.getByRole('heading',{name:'Diary 0'}).waitFor();
  assert.equal(await eye.getAttribute('aria-pressed'),'true');
  assert.ok(!secret.test(await page.locator('#root').innerHTML()),'reload starts hidden');
  const second=await context.newPage();await second.goto(origin);await second.getByRole('heading',{name:'Diary 0'}).waitFor();
  await eye.click();
  await second.waitForFunction(()=>document.querySelector('[aria-label="Hide client details"]').getAttribute('aria-pressed')==='false');
  await page.getByLabel('Note',{exact:true}).fill('Edited confidential');await eye.click();await eye.click();
  assert.equal(await page.getByLabel('Note',{exact:true}).inputValue(),'Edited confidential','toggle never rewrites form state');
  await eye.click();await page.goto(origin+'/public');await page.getByRole('heading',{name:'Diary 0'}).waitFor();
  assert.equal(await page.getByText('Priya Secretson',{exact:true}).count(),1,'public screens ignore owner display preference');
  const denied=await browser.newContext();await denied.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage denied');}});});
  const third=await denied.newPage();await third.goto(origin);await third.getByRole('button',{name:'Hide client details',exact:true}).click();
  assert.ok(!secret.test(await third.locator('#root').innerHTML()),'storage failure still allows concealment');
  assert.deepEqual(errors,[]);
  console.log('PASS: 10 privacy contracts: reversible eye/keyboard/focus, DOM concealment, readonly private controls, unchanged records, navigation, reload, cross-tab preference, public isolation, denied storage and original layout.');
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
