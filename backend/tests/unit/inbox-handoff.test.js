import {describe,it,expect} from 'vitest';
import {inboxHandoff} from '../../src/lib/inbox-handoff.js';
const now=Date.parse('2026-11-16T12:00:00Z');
const m=(id,minutes,extra={})=>({id,direction:'inbound',created_at:new Date(now-minutes*60000).toISOString(),content:'When can I book?',...extra});
const hand=rows=>inboxHandoff(rows,{now,replyOwed:t=>!/^thanks/i.test(t)});
describe('current Inbox handovers',()=>{
 it('names the missing story context and gives a reply action',()=>{expect(hand([m('a',10,{escalated:true,escalated_reason:'story_context:unavailable'})])).toMatchObject({title:'Story context is missing',action:'reply',waiting_since:'2026-11-16T11:50:00.000Z'});});
 it('clears a past escalation once a reply was sent',()=>{expect(hand([m('a',10,{escalated:true,escalated_reason:'story_context:unavailable'}),m('b',1,{direction:'outbound'})])).toBe(null);});
 it('does not attach a previous resolved story hold to a new question',()=>{expect(hand([m('old',30,{escalated:true,escalated_reason:'story_context:unavailable'}),m('sent',20,{direction:'outbound'}),m('new',2)])).toMatchObject({message_id:'new',reason:'',title:'Waiting for a reply'});});
 it('keeps a pending booking decision after an acknowledgement',()=>{expect(hand([m('a',10,{escalated:true,escalated_reason:'appointment_change:short_notice'}),m('b',1,{direction:'outbound'})])).toMatchObject({action:'diary',appointment_decision:true});});
 it('drops resolved booking decisions',()=>{expect(hand([m('a',10,{escalated:true,resolved:true,escalated_reason:'appointment_change:short_notice'})])).toBe(null);});
 it('never revives historical or future handovers',()=>{expect(hand([m('old',8*24*60,{escalated:true,escalated_reason:'appointment_change:short_notice'})])).toBe(null);expect(hand([m('future',-10)])).toBe(null);});
 it('does not ask for a reply to a standalone thank-you',()=>{expect(hand([m('thanks',1,{content:'Thanks lovely xx'})])).toBe(null);});
 it('does not treat a failed outbound send as an answer',()=>{expect(hand([m('a',10),m('b',1,{direction:'outbound',send_status:'failed'})])).toMatchObject({message_id:'a'});});
 it('handles invalid timestamps without inventing a waiting time',()=>{expect(hand([m('a',0,{created_at:'bad'})])).toBe(null);});
});

it('keeps a held story follow-up visible even when the wording sounds passive',()=>{
 expect(inboxHandoff([m('story',5,{content:'Keeping an eye on December xx',escalated:true,escalated_reason:'story_context:unavailable'})],{now,replyOwed:()=>false})).toMatchObject({title:'Story context is missing'});
});
