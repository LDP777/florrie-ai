/**
 * What "Messages paused" is allowed to stop, and what it must never stop.
 *
 * 1 September 2026. Ellie: "How do I turn it off for now as it keeps messaging
 * people things that don't make sense with our messages xx" ... "I thought i
 * did in settings". She had. The switch was wrong in both directions at once:
 * it stopped none of Florrie's replies, and it did stop her clients' booking
 * confirmations, 24h reminders and calendar links.
 *
 * These tests are the contract, written against the source, so that neither
 * half can quietly come back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mayFlorrieSend } from '../../src/services/ai-front-desk.js';
import { SETTINGS } from '../../src/lib/app-settings.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = rel => readFileSync(join(SRC, rel), 'utf8');

const openDials = {
  classification: { intent: 'price_enquiry', confidence: 0.99 },
  groundedDecision: { grounded: true },
  known: false,
  autonomyOverride: 'florrie',
  threshold: 0.5,
  message: 'how much is a lash lift',
  ownerPresent: { present: false },
};

describe('the pause stops Florrie speaking', () => {
  it('stops a reply that every other dial approved', () => {
    expect(mayFlorrieSend({ ...openDials, florriePaused: false })).toBe(true);
    expect(mayFlorrieSend({ ...openDials, florriePaused: true })).toBe(false);
  });

  it('outranks a client explicitly whitelisted for Florrie', () => {
    expect(mayFlorrieSend({ ...openDials, autonomyOverride: 'florrie', florriePaused: true })).toBe(false);
  });

  it('is read from the beautician row on the reply path', () => {
    // The whole original defect: nothing on this path had ever read the flag.
    expect(read('services/ai-front-desk.js'))
      .toMatch(/client_reminder_prefs\?\.paused === true/);
  });

  it('stops the Instagram redirect, which is also Florrie speaking unprompted', () => {
    expect(read('routes/instagram-webhooks.js'))
      .toMatch(/dmMode === 'redirect' && !florriePaused/);
  });
});

describe('the pause never stops the client booking admin', () => {
  const notifications = read('services/notifications.js');
  const appointments = read('routes/appointments.js');

  it('booking confirmations, 24h reminders and moved-appointment alerts read no pause flag', () => {
    expect(notifications).not.toMatch(/prefs\.paused/);
    expect(appointments).not.toMatch(/prefs\.paused/);
  });

  it('leaves the pause on proactive sends, which ARE Florrie speaking', () => {
    // Gap offers, rebook nudges, aftercare, marketing. Not booking details.
    expect(notifications).toMatch(/beauticianPrefs\?\.paused/);
    expect(read('services/automations.js')).toMatch(/prefs\.paused/);
  });

  it('has no per-type switch left for confirmations or reminders either', () => {
    // Owner's instruction: these are always enabled. A switch nobody should
    // ever touch is one somebody eventually touches by accident.
    expect(notifications).not.toMatch(/prefs\.booking_confirmation/);
    expect(notifications).not.toMatch(/prefs\.email_confirmation/);
    expect(notifications).not.toMatch(/prefs\.reminder_24h/);
    expect(notifications).not.toMatch(/prefs\.email_reminder/);
  });

  it('does not block a message Ellie sends by pressing a button herself', () => {
    expect(appointments).not.toMatch(/Messages are paused\. Turn the pause off/);
  });
});

describe('the words on the switch', () => {
  const pause = SETTINGS.find(s => s.id === 'pause_all_messages');

  it('no longer claims to stop everything including reminders', () => {
    expect(pause.means).not.toMatch(/including reminders/i);
    expect(pause.onSaid).not.toMatch(/Nothing automated goes out/i);
  });

  it('says what it actually does, in both directions', () => {
    expect(pause.means).toMatch(/Florrie answering your clients/i);
    expect(pause.means).toMatch(/NOT affected/);
    expect(pause.onSaid).toMatch(/Confirmations and reminders carry on/i);
  });

  it('answers the words Ellie actually used', () => {
    // She said "how do I turn it off"; the voice commander has to match that.
    expect(pause.says).toContain('turn florrie off');
    expect(pause.says).toContain('stop florrie messaging people');
  });

  it('offers no setting for turning confirmations or reminders off', () => {
    const ids = SETTINGS.map(s => s.id);
    expect(ids).not.toContain('booking_confirmations');
    expect(ids).not.toContain('confirmation_emails');
  });
});
