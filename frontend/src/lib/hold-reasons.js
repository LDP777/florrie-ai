/**
 * Why Florrie held a message, said to the person who has to act on it.
 *
 * The backend records a code (ai-front-desk.js writes `escalated_reason`) and
 * the Outbox and Escalations pages were printing that code raw:
 * "client_expressed_apprehension" is true, and useless to somebody with a
 * client waiting. Each sentence here says what happened and what to do, in
 * the order the owner needs it. Unknown codes fall through untouched so a
 * new reason is never hidden, only unpolished.
 */
const EXACT = {
  client_expressed_apprehension: 'She sounds nervous. She wants you, not an answer. Florrie has drafted something, but this one reads better in your words.',
  training_enquiry: 'A training enquiry, not a treatment. Course sales are yours: Florrie has drafted the date, price and enrol link for you to send or change.',
  florrie_paused: 'Florrie is paused, so she drafted this and left it for you.',
  subscription_lapsed: 'Your Florrie plan is not active, so she drafted this rather than sending it. Start your plan and she replies herself again.',
  no_treatments_yet: 'You have no treatments or notes set up yet, so Florrie has nothing true to answer from. Add your treatments and she can reply herself.',
  owner_is_in_this_thread: 'You are already talking to this client, so Florrie stayed out and drafted this for you instead.',
  thread_is_hers: 'You replied in this thread recently, so it stays yours. Florrie drafted, you send.',
  thread_unreadable: 'Florrie could not read this conversation, so she would not reply into it blind.',
  inbound_budget_exhausted: 'This client has sent a lot of messages in the last hour. Florrie stopped replying to them automatically.',
  held_after_generation: 'Florrie wrote a reply but was not sure it was right, so she held it for you.',
  grounded_replies_switched_off: 'Auto-replies are off in your settings, so this is a draft.',
};

const PREFIXED = [
  [/^client_is_at_the_door/, 'This client is at your door now. Florrie has not replied.'],
  [/^confirmation_resend:no_upcoming_booking/, 'They asked for their confirmation, but Florrie could not find an upcoming booking for them.'],
  [/^confirmation_resend:/, 'They asked for their confirmation and Florrie could not resend it herself.'],
  [/^client_set_to:just_me/, 'You set this client to "just me", so Florrie drafts and you send.'],
  [/^client_set_to:drafts/, 'You set this client to "drafts first", so Florrie drafts and you send.'],
  [/^Low confidence/i, 'Florrie was not sure enough to send this herself.'],
  [/^Processing error/i, 'Something went wrong while Florrie was writing, so this needs you.'],
];

export function explainHold(code, fallback = 'Have a look before it goes.') {
  const c = String(code || '').trim();
  if (!c) return fallback;
  if (EXACT[c]) return EXACT[c];
  for (const [re, text] of PREFIXED) if (re.test(c)) return text;
  return c;
}
