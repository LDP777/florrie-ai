import test from 'node:test';
import assert from 'node:assert/strict';
import { careCardView, careCardDraft, loadCareCards, saveCareCard, setCareCardArchived } from './aftercare-cards.js';

const card = { id:'card-a',beautician_id:'salon-a',treatment_name:'Saved treatment',icon:'flower',instructions:[{title:'A saved step',text:'Original guidance',reference:'Retained metadata'}],products:['Saved product'],personal_note:'Original note',auto_send:true,send_after_hours:72,rebook_nudge_days:56,archived_at:null,updated_at:'2026-01-01T00:00:00Z' };
function fixture(result = {data:card,error:null}) {
  const calls=[];
  const q={};
  for(const method of ['select','eq','order','insert','update'])q[method]=(...args)=>{calls.push([method,...args]);return q;};
  q.single=async()=>result;q.then=resolve=>Promise.resolve(result).then(resolve);
  return {calls,client:{from:table=>{calls.push(['from',table]);return q;}}};
}

test('edit preserves stored guidance and only writes content to the current salon/row/version',async()=>{
  const f=fixture();const draft=careCardDraft(card);draft.personal_note='Owner correction';
  draft.beautician_id='foreign';draft.auto_send=false;draft.archived_at='2027-01-01';draft.send_after_hours=0;
  await saveCareCard(f.client,'salon-a',draft,card);
  assert.deepEqual(f.calls.filter(c=>c[0]==='eq'),[['eq','id','card-a'],['eq','beautician_id','salon-a'],['eq','updated_at',card.updated_at]]);
  assert.deepEqual(f.calls.find(c=>c[0]==='update')[1],{treatment_name:card.treatment_name,icon:'flower',instructions:card.instructions,products:card.products,personal_note:'Owner correction'});
  assert.equal(card.personal_note,'Original note');
});

test('wrong-owner and stale edits fail without pretending to save',async()=>{
  const f=fixture();
  await assert.rejects(saveCareCard(f.client,'salon-b',careCardDraft(card),card),/not available in your salon/);
  assert.deepEqual(f.calls,[]);
  const stale=fixture({data:null,error:{code:'PGRST116'}});
  await assert.rejects(saveCareCard(stale.client,'salon-a',careCardDraft(card),card),error=>error.code==='CARE_CARD_CONFLICT');
  await assert.rejects(saveCareCard(f.client,'salon-a',careCardDraft(card),{...card,updated_at:null}),/Reload/);
});

test('archive and restore only change the archive timestamp, retaining delivery preferences',async()=>{
  const archived=fixture();await setCareCardArchived(archived.client,'salon-a',card,true);
  const change=archived.calls.find(c=>c[0]==='update')[1];
  assert.deepEqual(Object.keys(change),['archived_at']);assert.ok(Number.isFinite(Date.parse(change.archived_at)));
  const restore=fixture();await setCareCardArchived(restore.client,'salon-a',{...card,archived_at:change.archived_at},false);
  assert.deepEqual(restore.calls.find(c=>c[0]==='update')[1],{archived_at:null});
  assert.deepEqual(restore.calls.filter(c=>c[0]==='eq'),[['eq','id','card-a'],['eq','beautician_id','salon-a'],['eq','updated_at',card.updated_at]]);
});

test('creation keeps sending off and reads require an explicit salon and the archive schema',async()=>{
  assert.deepEqual(careCardView({...card,instructions:[],products:[]}).instructions,[]);
  assert.deepEqual(careCardView({...card,instructions:[],products:[]}).products,[]);
  const blank = {...card,instructions:[{title:' ',text:''}],products:['','  ']};
  assert.deepEqual(careCardView(blank).instructions,[]);assert.deepEqual(careCardView(blank).products,[]);
  assert.deepEqual(careCardDraft(blank).instructions,blank.instructions);
  const f=fixture();const draft=careCardDraft(card);draft.auto_send=true;draft.id='foreign';
  await saveCareCard(f.client,'salon-a',draft);
  const inserted=f.calls.find(c=>c[0]==='insert')[1];
  assert.equal(inserted.auto_send,false);assert.equal(inserted.beautician_id,'salon-a');assert.equal('id' in inserted,false);
  const read=fixture({data:[card],error:null});
  await loadCareCards(read.client,'salon-a');assert.ok(read.calls.some(c=>c[0]==='eq'&&c[1]==='beautician_id'&&c[2]==='salon-a'));
  const old=fixture({data:[{id:'old'}],error:null});await assert.rejects(loadCareCards(old.client,'salon-a'),error=>error.code==='PGRST204');
  const absent=fixture();await assert.rejects(loadCareCards(absent.client,null),/Sign in/);assert.deepEqual(absent.calls,[]);
});
