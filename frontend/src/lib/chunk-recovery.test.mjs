import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverMissingChunk,isChunkLoadError} from './chunk-recovery.js';
const error=new TypeError('Failed to fetch dynamically imported module: https://florrie.ai/assets/Hub-old.js');
test('recovers a stale deployment once and preserves authentication storage',()=>{
 const data=new Map([['supabase.auth','unchanged']]);const storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};let reloads=0;
 const args={error,storage,reload:()=>reloads++,now:1000000};assert.equal(recoverMissingChunk(args),true);assert.equal(recoverMissingChunk({...args,now:1001000}),false);assert.equal(reloads,1);assert.equal(data.get('supabase.auth'),'unchanged');
});
test('does not reload native bundles, other errors or when storage is blocked',()=>{
 let reloads=0;const storage={getItem:()=>{throw new Error('blocked')},setItem:()=>{}};
 for(const args of [{error,native:true},{error:new Error('render bug')},{error}])assert.equal(recoverMissingChunk({...args,storage,reload:()=>reloads++}),false);assert.equal(reloads,0);
});
test('recognises Safari module failures without mistaking ordinary request failures',()=>{
 assert.equal(isChunkLoadError(new TypeError('Importing a module script failed.')),true);assert.equal(isChunkLoadError(new Error('Failed to fetch')),false);
});
