/**
 * What to do with an inbound webhook when the secret that would verify it is
 * not configured.
 *
 * The answer used to be "accept it", by default, forever, with a warning
 * nobody read. On 2 September that became "reject it", which is the only
 * defensible answer for a national launch: with the secret missing, anyone
 * can POST a fabricated client message for any salon and Florrie will reply
 * in that salon's name.
 *
 * Then the founder, the same night: "Make sure this can't happen, I need IG
 * to stay live." Because rejecting has a cost too. If a secret is missing
 * from production on the day this deploys, that channel returns 503 and the
 * pilot salon's Instagram DMs stop arriving until somebody notices and sets
 * it. Meta retries for a while, so nothing is lost, but nothing is answered
 * either.
 *
 * So there are three answers, not two, and the difference is the date.
 *
 *   ACCEPT, LOUDLY   until the deadline below. The payload is processed and
 *                    the service says so at error level on every request,
 *                    in Sentry, and in /health as a warning that names the
 *                    variable. A live channel cannot go dark on deploy day
 *                    because of a config gap, and nobody can fail to hear
 *                    about the gap.
 *   REJECT           after the deadline. The window is for setting the
 *                    secret, not for living without it, and a grace period
 *                    with no end is the old behaviour under a new name.
 *   ACCEPT, QUIETLY  only with WEBHOOK_ALLOW_UNSIGNED=true, for local
 *                    development, and index.js logs an error at boot if it
 *                    finds that set in production.
 *
 * The deadline is a fixed date rather than "N days from boot" so a restart
 * cannot reset it, and so the same policy is in force on every host at once,
 * which matters here because there are two backend hosts in play and the
 * secret may be set on one and not the other.
 */
import logger from './logger.js';

/**
 * After this instant an unsigned webhook on a channel with no secret is
 * refused. One week from the change that introduced the policy. If this date
 * has passed and a channel is still unsecured, that is a decision somebody
 * has to make on purpose, by setting the secret, not one the service makes
 * for them by staying open.
 */
export const UNSIGNED_WEBHOOK_DEADLINE = new Date('2026-09-09T00:00:00Z');

/**
 * @param {object} a
 * @param {string} a.channel   'whatsapp' | 'instagram' | 'bird_sms' | 'twilio_sms'
 * @param {string} a.envVar    the variable that should hold the secret, for the message
 * @param {Date|number} [a.now]
 * @param {NodeJS.ProcessEnv} [a.env]
 * @returns {{accept: boolean, mode: 'dev_override'|'grace'|'reject', daysLeft: number|null, detail: string}}
 */
export function unsignedWebhookPolicy({ channel, envVar, now = Date.now(), env = process.env }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (env.WEBHOOK_ALLOW_UNSIGNED === 'true') {
    return {
      accept: true,
      mode: 'dev_override',
      daysLeft: null,
      detail: `${envVar} not set; WEBHOOK_ALLOW_UNSIGNED=true so accepting an unverified ${channel} payload (never in production)`,
    };
  }

  const msLeft = UNSIGNED_WEBHOOK_DEADLINE.getTime() - nowMs;
  if (msLeft > 0) {
    const daysLeft = Math.ceil(msLeft / 86_400_000);
    return {
      accept: true,
      mode: 'grace',
      daysLeft,
      detail: `${envVar} is NOT SET. Accepting this unverified ${channel} payload so the channel stays live, for ${daysLeft} more day(s). `
        + `After ${UNSIGNED_WEBHOOK_DEADLINE.toISOString().slice(0, 10)} it will be refused. Set ${envVar} now.`,
    };
  }

  return {
    accept: false,
    mode: 'reject',
    daysLeft: 0,
    detail: `${envVar} not configured and the grace period ended on ${UNSIGNED_WEBHOOK_DEADLINE.toISOString().slice(0, 10)}; rejecting unsigned ${channel} payload`,
  };
}

/**
 * Which channels are currently running without a secret. Read by /health so
 * the gap is visible in one HTTP call the moment this deploys, rather than
 * discovered from a 503 a week later.
 */
export const WEBHOOK_SECRETS = [
  { channel: 'whatsapp', envVar: 'WHATSAPP_APP_SECRET', alternates: ['META_APP_SECRET'] },
  { channel: 'instagram', envVar: 'INSTAGRAM_APP_SECRET', alternates: ['META_APP_SECRET'] },
  { channel: 'bird_sms', envVar: 'BIRD_WEBHOOK_TOKEN', alternates: [] },
  { channel: 'twilio_sms', envVar: 'TWILIO_AUTH_TOKEN', alternates: [] },
];

export function unsecuredWebhookChannels({ now = Date.now(), env = process.env } = {}) {
  return WEBHOOK_SECRETS
    .filter(({ envVar, alternates }) => !env[envVar] && !alternates.some((a) => env[a]))
    .map(({ channel, envVar }) => ({ channel, envVar, ...unsignedWebhookPolicy({ channel, envVar, now, env }) }));
}

// One Sentry event per channel per process, not one per request. The log
// line is per request; that is what a log is for. Sentry is for waking
// somebody up, and waking them up four hundred times says less than once.
const reported = new Set();
export function reportUnsecuredOnce(channel, detail, Sentry) {
  if (reported.has(channel)) return;
  reported.add(channel);
  try { Sentry?.captureMessage?.(`Inbound ${channel} webhook running with no secret: ${detail}`, 'error'); } catch { /* never */ }
  logger.error({ channel }, detail);
}

/** Tests only. */
export function __resetUnsecuredReports() { reported.clear(); }
