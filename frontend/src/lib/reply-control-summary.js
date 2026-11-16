const MODES = { auto: 'Send automatically', ask: 'Draft for approval', off: 'Off' };
const TYPES = ['rebook_nudge', 'predictive_nudge', 'comeback', 'review_request', 'aftercare_followup', 'ai_checkin', 'gap_fill', 'waitlist_alert', 'marketing'];
export function replyControlSummary(owner = {}) {
  const autonomy = owner.autonomy || {};
  const overrides = TYPES.filter(key => Object.hasOwn(MODES, autonomy[key])).length;
  return {
    paused: owner.client_reminder_prefs?.paused === true,
    rows: [
      ['WhatsApp & SMS new enquiries', owner.auto_reply_enabled === true ? 'Automatic replies enabled' : 'Automatic replies off'],
      ['Grounded booking help', autonomy.grounded_replies === false ? 'Off' : 'Enabled'],
      ['Instagram messages', ({ ai: 'AI replies enabled', redirect: 'Redirect to WhatsApp', off: 'Automatic replies off' })[owner.instagram_dm_mode] || 'Automatic replies off'],
      ['Proactive message default', MODES[autonomy.proactive] || MODES.ask],
    ],
    overrides: overrides ? `${overrides} message ${overrides === 1 ? 'type has its' : 'types have their'} own setting.` : 'No individual message settings override the default.',
  };
}
