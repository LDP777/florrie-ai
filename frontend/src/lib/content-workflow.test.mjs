import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHashtags,scheduleInstant,localScheduleValue,contentRequest} from './content-workflow.js';
test('hashtag edits are deduplicated without saving surrounding prose',()=>assert.deepEqual(parseHashtags('#brows notes #brows #éclat'),['#brows','#éclat']));
test('schedule validation rejects invalid and elapsed times',()=>{for(const value of ['', 'bad','2000-01-01T10:00'])assert.throws(()=>scheduleInstant(value));});
test('editing a date roundtrips its instant at minute precision',()=>{const date='2099-07-01T12:30:00.000Z';assert.equal(scheduleInstant(localScheduleValue(date)),date);});
test('requests preserve a rejection without retrying',async()=>{let calls=0;await assert.rejects(contentRequest('/content',{token:'test',method:'PATCH',body:{caption:'draft'},request:async()=>{calls++;return {ok:false,status:409,json:async()=>({error:'Post changed'})};}}),/Post changed/);assert.equal(calls,1);});
test('a stalled request times out and aborts',async()=>{let signal;await assert.rejects(contentRequest('/content',{token:'test',timeoutMs:5,request:async(_url,opts)=>{signal=opts.signal;return new Promise(()=>{});}}),/taking too long/);assert.equal(signal.aborted,true);});
