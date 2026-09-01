/**
 * Florrie does not talk over Ellie.
 *
 * 1 September 2026, Instagram, a real thread:
 *
 *   Client  Can I change my appointment on 24th from brow maintenance to
 *           full lami please girl xxx
 *   Ellie   Yes of course girl, could you get to me for 12.15 though? Xxx
 *   Client  Yes no problem!! Xxx
 *   Florrie hey lovely, i'll just check if you need a patch test for the
 *           full lami and come straight back to you xx
 *
 * Ellie had already handled it and the client had already agreed. Florrie
 * arrived after the conversation was finished, answering a message that was
 * addressed to somebody else. Ellie's words for it: "it keeps messaging people
 * things that don't make sense with our messages".
 *
 * Two separate faults produced that message, and this file is the second one.
 *
 * The FIRST is that Florrie could not see Ellie's line at all. Ellie typed it
 * in the Instagram app on her phone, and we subscribed only to `messages`, not
 * `message_echoes`, so nothing the owner sends herself was ever written to the
 * thread. The transcript handed to the model was:
 *
 *   Client  Can I change my appointment ... to full lami
 *   Client  Yes no problem!! Xxx
 *
 * From which "let me check whether you need a patch test" is a perfectly
 * sensible reply. The model was not wrong. It was answering a conversation
 * that did not happen. routes/instagram-webhooks.js now records echoes.
 *
 * The SECOND is that even with the full transcript, nothing anywhere said that
 * a human being was already in this conversation. Every dial we have is about
 * what Florrie is ALLOWED to say (grounded, confident, known client, trusted).
 * None of them asks whether anyone else is already saying it. So this does,
 * and it sits above all of them, because being right about patch tests is
 * worth nothing if the client is watching two people answer her at once.
 *
 * The rule: if Ellie has written in this thread herself in the last few hours,
 * Florrie does not send. She still drafts, and the draft still reaches Ellie.
 * The only thing that changes is who presses send.
 */

/**
 * How long Ellie counts as "in this conversation" after her last message.
 *
 * Six hours: long enough to cover an exchange that pauses while she is with a
 * client and picks up between appointments, short enough that a thread she
 * touched yesterday morning does not mute Florrie today.
 *
 * The two errors are not equal, which is why this is generous rather than
 * tight. Staying quiet costs a message Ellie was going to answer herself
 * anyway, which is exactly her life before Florrie existed. Speaking costs her
 * a client watching her assistant contradict her, in front of the client, in
 * her own voice, under her own name.
 */
export const OWNER_PRESENT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** authored_by values that mean the owner typed it herself. */
const HER_OWN_WORDS = new Set(['human', 'ai_edited']);

/**
 * Was the owner personally in this thread recently.
 *
 * @param {object} a
 * @param {Array<{direction?: string, authored_by?: string, created_at?: string}>} a.conversation
 *   Recent messages, any order. Rows missing authored_by are ignored rather
 *   than guessed at: see the note on 'unknown' below.
 * @param {Date|number} [a.now]
 * @param {string|null} [a.currentMessageId] the inbound message being answered,
 *   excluded so a client's own message can never look like the owner's.
 * @returns {{present: boolean, at: string|null, reason: string}}
 */
export function ownerIsInThread({ conversation, now = Date.now(), currentMessageId = null }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const rows = Array.isArray(conversation) ? conversation : [];

  let latest = null;
  for (const m of rows) {
    if (!m || m.direction !== 'outbound') continue;
    if (currentMessageId && m.id === currentMessageId) continue;

    // 'ai_edited' counts. She read Florrie's draft, changed it, and sent it:
    // she is at her phone, in this thread, right now. That is the whole
    // question being asked here, and it is a different question from whose
    // prose it is (lib/idiolect.js asks that one, and excludes ai_edited).
    if (!HER_OWN_WORDS.has(m.authored_by)) continue;

    // A row from before migration 20260805 carries 'unknown' because nothing
    // on it records who wrote it. Treating unknown as the owner would mute
    // Florrie on every thread with any history at all, so it is skipped. The
    // cost is that this rule is blind to messages sent before 5 August, which
    // are far too old to be a live conversation anyway.

    const at = Date.parse(m.created_at || '');
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest) latest = at;
  }

  if (latest === null) return { present: false, at: null, reason: 'owner_not_in_thread' };

  const age = nowMs - latest;
  // A timestamp in the future is a clock problem, not evidence of absence.
  // Treat it as present: the safe direction is silence.
  if (age > OWNER_PRESENT_WINDOW_MS) {
    return { present: false, at: new Date(latest).toISOString(), reason: 'owner_last_spoke_too_long_ago' };
  }

  return { present: true, at: new Date(latest).toISOString(), reason: 'owner_is_in_this_thread' };
}
