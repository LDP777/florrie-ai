import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startWhatsAppConnection} from './whatsapp-connect.js';
const api='https://api.florrie.ai', url=api+'/api/whatsapp/embedded#'+'a'.repeat(64);
const ok=async()=>({ok:true,json:async()=>({url})});
test('web starts an authenticated salon session before navigating',async()=>{
 let sent,opened;
 await startWhatsAppConnection({api,getToken:async()=>'session',native:false,fetchImpl:async(u,o)=>{sent={u,o};return ok();},navigateWeb:u=>{opened=u;}});
 assert.equal(sent.o.headers.Authorization,'Bearer session');assert.deepEqual(JSON.parse(sent.o.body),{platform:'web'});assert.equal(opened,url);
});
test('iPhone opens the system browser, without relying on a popup gesture',async()=>{
 let opened;
 await startWhatsAppConnection({api,getToken:async()=>'session',native:true,fetchImpl:ok,openNative:u=>{opened=u;},navigateWeb:()=>assert.fail('web navigation')});
 assert.equal(opened,url);
});
test('refuses foreign hosts, missing secrets, injected credentials and HTTP',async()=>{
 for(const bad of ['https://evil.test/api/whatsapp/embedded#'+'a'.repeat(64),api+'/api/whatsapp/embedded','https://user:pass@api.florrie.ai/api/whatsapp/embedded#'+'a'.repeat(64),url.replace('https:','http:')]){
  await assert.rejects(startWhatsAppConnection({api,getToken:async()=>'session',fetchImpl:async()=>({ok:true,json:async()=>({url:bad})}),navigateWeb:()=>assert.fail('navigated')}),/Invalid/);
 }
});
test('a session timeout finishes without opening Meta',async()=>{
 await assert.rejects(startWhatsAppConnection({api,getToken:()=>new Promise(()=>{}),timeoutMs:5,fetchImpl:()=>assert.fail('fetch'),navigateWeb:()=>assert.fail('navigation')}),/too long/);
});
test('failed provider start and signed-out state remain recoverable errors',async()=>{
 await assert.rejects(startWhatsAppConnection({api,getToken:async()=>null,fetchImpl:()=>assert.fail('fetch')}),/sign in/);
 await assert.rejects(startWhatsAppConnection({api,getToken:async()=>'session',fetchImpl:async()=>({ok:false,json:async()=>({error:'Not ready'})})}),/Not ready/);
});
