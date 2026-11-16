import { INSTAGRAM_STORY_UNAVAILABLE_MARKER } from './instagram-story-context.js';
const WINDOW = 7 * 24 * 60 * 60 * 1000;

export function describeHandoff(reason = '', hasDraft = false) {
  if (reason.startsWith('appointment_change:')) return {title:'Booking change needs you',action:'diary',action_label:'Check diary'};
  if (reason.startsWith('story_context:')) return {title:'Story context is missing',action:'reply',action_label:'Read and reply'};
  if (reason.startsWith('diary_release:')) return {title:'Confirm when dates open',action:'reply',action_label:'Write a reply'};
  if (reason.startsWith('client_is_at_the_door')) return {title:'Client has arrived',action:'reply',action_label:'Write a reply'};
  if (reason.startsWith('confirmation_resend:')) return {title:'Confirmation needs checking',action:'diary',action_label:'Check diary'};
  if (/delivery_failed|Processing error|thread_unreadable|thread_refresh_unavailable/.test(reason)) return {title:'Reply needs checking',action:'reply',action_label:'Read and reply'};
  if (/client_set_to|owner_is_in_this_thread|thread_is_hers/.test(reason)) return {title:'This conversation is yours',action:'reply',action_label:'Write a reply'};
  if (reason === 'florrie_paused') return {title:'Florrie is paused',action:'reply',action_label:'Write a reply'};
  if (hasDraft) return {title:'Florrie held a reply',action:'reply',action_label:'Read and reply'};
  return {title:reason ? 'Florrie needs your help' : 'Waiting for a reply',action:'reply',action_label:'Write a reply'};
}

// A previous hold is context only while its inbound turn is unanswered. An
// unresolved booking decision survives an acknowledgement until marked resolved.
export function inboxHandoff(messages, { now = Date.now(), replyOwed = () => true } = {}) {
  const rows = [...messages].filter(m => Number.isFinite(Date.parse(m.created_at)))
    .sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const inbound = rows.find(m => m.direction === 'inbound');
  const sent = rows.find(m => m.direction === 'outbound' && m.send_status !== 'failed');
  const recent = m => now - Date.parse(m.created_at) <= WINDOW && Date.parse(m.created_at) <= now;
  const decision = rows.find(m => m.direction === 'inbound' && m.escalated && !m.resolved
    && String(m.escalated_reason || '').startsWith('appointment_change:') && recent(m));
  const unanswered = inbound && !inbound.resolved && recent(inbound)
    && (!sent || Date.parse(inbound.created_at) > Date.parse(sent.created_at))
    && (replyOwed(String(inbound.content || '').split(INSTAGRAM_STORY_UNAVAILABLE_MARKER)[0].trim(), {intent:inbound.ai_intent})
      || (inbound.escalated && /^(story_context:|diary_release:)/.test(inbound.escalated_reason || '')));
  if (!decision && !unanswered) return null;
  const hold = unanswered ? rows.find(m => m.direction === 'inbound' && m.escalated && !m.resolved
    && recent(m) && (!sent || Date.parse(m.created_at) > Date.parse(sent.created_at))) : null;
  const source = decision || hold || inbound;
  const reason = source.escalated_reason || '';
  return { ...describeHandoff(reason,!!source.ai_response), reason, message_id:source.id,
    waiting_since:unanswered ? inbound.created_at : source.created_at,
    appointment_decision:!!decision, has_draft:!!source.ai_response };
}
