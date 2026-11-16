import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSetupDraft, writeSetupDraft, clearSetupDraft } from './setup-draft.js';
const draft=()=>({step:2,firstName:'Alex',businessName:'Demo',slug:'demo',hours:{mon:{enabled:true,start:'09:00',end:'17:00'}},treatments:[{id:'12345678-1234-4234-8234-123456789012',name:'Brows',price_cents:'35.25',duration_minutes:45}]});
const store=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
test('reloading preserves a stable treatment ID and unfinished money entry in this salon only',()=>{const s=store();writeSetupDraft(s,'one',draft());assert.deepEqual(readSetupDraft(s,'one').treatments,draft().treatments);assert.equal(readSetupDraft(s,'two'),null);clearSetupDraft(s,'one');assert.equal(readSetupDraft(s,'one'),null);});
test('expired or corrupted drafts cannot replace the server resume state',()=>{const s=store();writeSetupDraft(s,'one',draft());assert.equal(readSetupDraft(s,'one',Date.now()+31*86400000),null);for(const bad of ['{broken',JSON.stringify({...draft(),savedAt:Date.now(),step:99}),JSON.stringify({...draft(),savedAt:Date.now(),treatments:[{id:'arbitrary',name:'Brows'}]})]){s.setItem('florrie-setup-draft-v1:one',bad);assert.equal(readSetupDraft(s,'one'),null);}});
test('unavailable local storage does not prevent saving completed steps online',()=>{assert.doesNotThrow(()=>writeSetupDraft(null,'one',draft()));assert.equal(readSetupDraft(null,'one'),null);assert.doesNotThrow(()=>clearSetupDraft(null,'one'));});
