import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendVoiceCommand} from './voice-command.js';
const auth={getSession:async()=>({data:{session:{access_token:'test'}}})};
test('an expired session cannot produce a simulated success or send a command',async()=>{
 let calls=0;
 await assert.rejects(sendVoiceCommand({auth:{getSession:async()=>({data:{session:null}})},url:'/voice',text:'Book it',request:async()=>{calls++;}}),/Sign in again/);
 assert.equal(calls,0);
});
test('a timed-out session cannot send the command later',async()=>{
 let release,calls=0;
 const session=new Promise(resolve=>{release=resolve;});
 await assert.rejects(sendVoiceCommand({auth:{getSession:()=>session},url:'/voice',text:'Book it',timeoutMs:5,request:async()=>{calls++;}}),/too long/);
 release({data:{session:{access_token:'test'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,0);
});
test('failed command is attempted once, with no automatic retry',async()=>{
 let calls=0;
 await assert.rejects(sendVoiceCommand({auth,url:'/voice',text:'Hello',request:async()=>{calls++;return {ok:false,json:async()=>({error:'Unavailable'})};}}),/Unavailable/);
 assert.equal(calls,1);
});
test('returns the real response and preserves proposed actions',async()=>{
 const answer={reply:'Please review',proposals:[{id:'p1'}]};
 assert.deepEqual(await sendVoiceCommand({auth,url:'/voice',text:'Hello',request:async()=>({ok:true,json:async()=>answer})}),answer);
});
