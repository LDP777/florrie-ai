import { useState, useEffect, useRef } from 'react';
import { useBeautician, fetchRows } from '../lib/supabase.js';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';

const MOCK_CONNECTED = {
  connected: true,
  phone: '+44 7700 900123',
  business_name: "Ellie's Brows",
  usage: { sms_sent: 34, whatsapp_sent: 53, total_sent: 87, free_limit: 120, remaining: 33, overage_total_pence: 0 },
};

const mockTemplates = [
  { id: 1, name: 'Booking confirmation', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 156, preview: "Hey {name}! Your {treatment} is booked for {date} at {time}. See you soon! 💕 - Ellie" },
  { id: 2, name: 'Appointment reminder (24h)', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 289, preview: "Hi {name}, just a reminder about your {treatment} tomorrow at {time}. Reply YES to confirm or call to reschedule. See you soon! ✨" },
  { id: 3, name: 'No-show follow-up', category: 'utility', status: 'approved', lastUsed: 'Yesterday', uses: 12, preview: "Hey {name}, we missed you today! No worries at all, life happens. Want me to rebook you? Just reply with a day that works 💛" },
  { id: 4, name: 'Aftercare instructions', category: 'utility', status: 'approved', lastUsed: '2 days ago', uses: 98, preview: "Hey {name}! Here are your aftercare tips for your {treatment}: {aftercare_link}. Any questions at all, just message me! 💆‍♀️" },
  { id: 5, name: 'Review request', category: 'marketing', status: 'approved', lastUsed: '3 days ago', uses: 45, preview: "Hi {name}! So glad you loved your {treatment} 🥰 If you have a sec, a Google review would mean the world: {review_link}" },
  { id: 6, name: 'Win-back offer', category: 'marketing', status: 'approved', lastUsed: '1 week ago', uses: 23, preview: "Hey {name}, it's been a while! I've got 10% off your next visit if you fancy coming back 💕 Book here: {booking_link}" },
  { id: 7, name: 'Rebook reminder', category: 'utility', status: 'approved', lastUsed: 'Today', uses: 67, preview: "Hi {name}! Your {treatment} is due for a top-up 💅 Shall I book you in? Reply with a day that works and I'll sort it!" },
  { id: 8, name: 'Birthday message', category: 'marketing', status: 'approved', lastUsed: '5 days ago', uses: 8, preview: "Happy birthday {name}! 🎂🎉 As a treat from me, here's a free brow wax on your next visit: {voucher_code}. Have the best day! 💕" },
  { id: 9, name: 'Waitlist slot offer', category: 'utility', status: 'pending', lastUsed: 'Never', uses: 0, preview: "Great news {name}! A {treatment} slot just opened up on {date} at {time}. Want it? Reply YES to grab it before it goes! ⚡" },
];

const autoReplyDefaults = [
  { id: 1, trigger: 'Outside business hours', response: "Hey! I'm not at the salon right now but I'll get back to you first thing tomorrow morning 💕 - Ellie", enabled: true },
  { id: 2, trigger: 'Pricing enquiry detected', response: "Thanks for asking! You can see all my prices and book directly here: {booking_link} 💅", enabled: true },
  { id: 3, trigger: 'Availability enquiry detected', response: "Let me check what I've got! My next available slots are: {next_slots}. Want me to book one? 🗓️", enabled: true },
  { id: 4, trigger: 'New message (no match)', response: null, enabled: false },
];

/**
 * apiFetch attaches the full response body to thrown errors so callers can
 * read structured diagnostic fields (diagnostic.code, meta_code, fbtrace_id…)
 * instead of only the human-readable message.
 */
async function apiFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(`${API_BASE}/api/whatsapp${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || 'Request failed');
    err.body = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

function UsageBar({ usage }) {
  if (!usage) return null;
  const { total_sent, free_limit, overage_total_pence } = usage;
  const pct = Math.min(100, Math.round((total_sent / free_limit) * 100));
  const isNearLimit = pct >= 80;
  const isOver = total_sent >= free_limit;
  const barColor = isOver ? '#E85D75' : isNearLimit ? '#FFB74D' : '#25D366';

  return (
    <div style={styles.usageBar}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>
          {total_sent} / {free_limit} messages this month
        </span>
        {isOver && overage_total_pence > 0 && (
          <span style={{ fontSize: 11, color: '#E85D75', fontWeight: 600 }}>
            +{(overage_total_pence / 100).toFixed(2)} overage
          </span>
        )}
      </div>
      <div style={{ height: 6, background: 'var(--border, #F0ECE8)', borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
      {isOver && (
        <div style={{ fontSize: 11, color: '#E85D75', marginTop: 4 }}>
          Over limit, extra messages billed at 5p each
        </div>
      )}
      {!isOver && isNearLimit && (
        <div style={{ fontSize: 11, color: '#E65100', marginTop: 4 }}>
          Getting close, {free_limit - total_sent} left this month
        </div>
      )}
    </div>
  );
}

/**
 * Per-diagnostic-code presentation. Keeps the content side of things in one
 * place so ConnectFlow can stay focused on the flow itself.
 */
const DIAGNOSTIC_META = {
  on_consumer_whatsapp: {
    icon: '📱',
    title: 'Delete WhatsApp on this number first',
    tone: 'warning',
    steps: [
      'Open WhatsApp or WhatsApp Business on the phone.',
      'Go to Settings → Account → Delete my account.',
      'Enter this exact number and confirm.',
      'Wait at least 2 hours for Meta to release the number.',
      'Come back here and tap Try again.',
    ],
  },
  on_other_waba: {
    icon: '🔗',
    title: 'Number is tied to another WhatsApp provider',
    tone: 'blocked',
    steps: [
      'Someone else is already using this number with the WhatsApp Business API.',
      "Sign in to that provider's dashboard and release the number.",
      'If you don\'t know who that is, contact Meta Business Support.',
      'Once released, try again here.',
    ],
  },
  verified_name_collision: {
    icon: '⚠️',
    title: 'Business display name clash',
    tone: 'warning',
    steps: [
      'Your business name is in use elsewhere on WhatsApp.',
      "We've retried with a duplicate-name override.",
      'If this keeps happening, change your business name in Settings to something more unique and try again.',
    ],
  },
  cooldown_active: {
    icon: '⏳',
    title: 'Meta is still processing this number',
    tone: 'waiting',
    steps: [
      'Meta holds numbers for a short period after any change.',
      'It usually clears in a few hours, sometimes up to 24.',
      "We've queued an automatic retry. You don't have to do anything.",
    ],
  },
  invalid_number: {
    icon: '❌',
    title: "Meta didn't recognise that number",
    tone: 'error',
    steps: [
      'Double-check the country code.',
      'For UK, enter it as 07… or +447….',
      'Use digits only, no spaces or dashes.',
    ],
  },
  invalid_format: {
    icon: '❌',
    title: 'Number format looks off',
    tone: 'error',
    steps: [
      'UK mobiles should be 11 digits starting with 07.',
      'For international numbers, include the + and country code.',
    ],
  },
  missing_business_name: {
    icon: '📛',
    title: 'Set your business name first',
    tone: 'error',
    steps: [
      'WhatsApp uses your business name as the display name clients see.',
      'Go to Settings and add it before connecting.',
    ],
  },
  rate_limit: {
    icon: '🚦',
    title: 'Too many attempts in a short window',
    tone: 'waiting',
    steps: [
      'Meta has temporarily throttled this number.',
      "We've queued an automatic retry for when the window clears.",
    ],
  },
  pin_error: {
    icon: '⚠️',
    title: 'Cloud API registration failed',
    tone: 'error',
    steps: [
      'WhatsApp rejected the activation PIN. This usually clears quickly.',
      'Try the Reset button to clear and start again from scratch.',
      'If it keeps happening, contact support.',
    ],
  },
  waba_not_approved: {
    icon: '🛠️',
    title: 'Configuration issue on our side',
    tone: 'error',
    steps: [
      'This is a Florrie-side problem, not yours.',
      "We've been notified and are looking at it.",
      'Try again in a few minutes or contact support if it persists.',
    ],
  },
  unknown: {
    icon: '⚠️',
    title: "We couldn't connect this number",
    tone: 'error',
    steps: [
      "Meta rejected the request but didn't give us a clear reason.",
      'Tap Show technical details below and send the numbers to support.',
    ],
  },
};

function formatCountdown(seconds) {
  if (seconds <= 0) return 'Ready to retry';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `Try again in ${h}h ${m}m`;
  if (m > 0) return `Try again in ${m}m ${s.toString().padStart(2, '0')}s`;
  return `Try again in ${s}s`;
}

/**
 * Small inline Reset button. Calls POST /reset, optionally with a phone so the
 * backend can also force-delete a phone_number_id that exists on Meta's side
 * but isn't recorded in our DB (the usual "stuck half-finished attempt" path).
 */
function ResetButton({ phone, onDone, variant = 'inline', children = 'Reset and start again' }) {
  const [busy, setBusy] = useState(false);
  const isDanger = variant === 'danger';

  async function handleReset() {
    const ok = confirm(
      phone
        ? `Reset this number with Meta and clear the connection so you can start fresh? This is safe, you'll need to verify the number again.`
        : 'Reset the WhatsApp connection and start fresh? This is safe, you can reconnect right after.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch('/reset', {
        method: 'POST',
        body: JSON.stringify(phone ? { phone } : {}),
      });
      onDone?.();
    } catch (err) {
      logger.error('WhatsApp reset failed:', err);
      alert(err.message || 'Reset failed, try again');
    } finally {
      setBusy(false);
    }
  }

  const style = isDanger
    ? {
        padding: '10px 16px',
        borderRadius: 10,
        border: '1px solid var(--danger, #D4605C)',
        background: 'none',
        color: 'var(--danger, #D4605C)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }
    : {
        padding: '7px 12px',
        borderRadius: 8,
        border: '1px solid #F5C6C0',
        background: '#fff',
        color: '#8A2A1C',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      };

  return (
    <button type="button" onClick={handleReset} disabled={busy} style={style}>
      {busy ? 'Resetting…' : children}
    </button>
  );
}

function DiagnosticError({ error, errBody, onRetry, onReset, phone }) {
  const [showDetails, setShowDetails] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(null);

  const code = errBody?.diagnostic?.code || 'unknown';
  const meta = DIAGNOSTIC_META[code] || DIAGNOSTIC_META.unknown;
  const retryAfter = errBody?.diagnostic?.retryAfter;
  const autoRetryScheduled = !!errBody?.diagnostic?.autoRetryScheduled;

  useEffect(() => {
    if (!retryAfter) { setSecondsLeft(null); return; }
    const update = () => {
      const diff = new Date(retryAfter).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.floor(diff / 1000)));
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [retryAfter]);

  const toneStyles = {
    warning:  { bg: '#FFF8E1', border: '#FFE082', text: '#7B5E00' },
    blocked:  { bg: '#FDECEA', border: '#F5C6C0', text: '#8A2A1C' },
    waiting:  { bg: '#EDF3FA', border: '#CFD8E5', text: '#2E4A6B' },
    error:    { bg: '#FDECEA', border: '#F5C6C0', text: '#8A2A1C' },
  };
  const t = toneStyles[meta.tone] || toneStyles.error;

  const metaCode = errBody?.meta_code;
  const metaSubcode = errBody?.meta_subcode;
  const metaTitle = errBody?.meta_user_title;
  const fbtrace = errBody?.fbtrace_id;
  const hasTechDetails = metaCode || metaSubcode || fbtrace || metaTitle;

  // Reset makes sense for most terminal codes but not for "just wait" ones
  // where Meta is already managing the clock.
  const showResetCta = code !== 'cooldown_active' && code !== 'rate_limit' && code !== 'invalid_format' && code !== 'missing_business_name';

  return (
    <div style={{
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 14,
      padding: 14,
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 6, lineHeight: 1.3 }}>
            {meta.title}
          </div>
          <div style={{ fontSize: 13, color: t.text, lineHeight: 1.5, marginBottom: meta.steps.length ? 10 : 0 }}>
            {error.message || "We couldn't connect this number."}
          </div>
          {meta.steps && meta.steps.length > 0 && (
            <ol style={{ margin: '0 0 8px', padding: '0 0 0 18px', fontSize: 12, color: t.text, lineHeight: 1.6 }}>
              {meta.steps.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
            </ol>
          )}

          {autoRetryScheduled && (
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              color: t.text,
              marginTop: 8,
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.7)',
              borderRadius: 8,
              display: 'inline-block',
            }}>
              ⏳ Auto-retry queued — you don't need to do anything
            </div>
          )}

          {retryAfter && secondsLeft !== null && !autoRetryScheduled && (
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              color: t.text,
              marginTop: 8,
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.6)',
              borderRadius: 8,
              display: 'inline-block',
            }}>
              {formatCountdown(secondsLeft)}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: '#fff',
              color: t.text,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Check status
          </button>
        )}
        {showResetCta && onReset && (
          <ResetButton phone={phone} onDone={onReset} variant="inline">
            Reset and start again
          </ResetButton>
        )}
        {hasTechDetails && (
          <button
            type="button"
            onClick={() => setShowDetails(v => !v)}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: 'transparent',
              color: t.text,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {showDetails ? 'Hide technical details' : 'Show technical details'}
          </button>
        )}
      </div>

      {showDetails && hasTechDetails && (
        <div style={{
          marginTop: 10,
          padding: 10,
          background: 'rgba(255,255,255,0.7)',
          borderRadius: 8,
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          color: '#3A332E',
          lineHeight: 1.6,
        }}>
          {metaTitle && <div><b>Meta title:</b> {metaTitle}</div>}
          {metaCode && <div><b>Error code:</b> {metaCode}</div>}
          {metaSubcode && <div><b>Subcode:</b> {metaSubcode}</div>}
          {fbtrace && <div><b>Trace ID:</b> {fbtrace}</div>}
          {errBody?.diagnostic?.code && <div><b>Diagnosis:</b> {errBody.diagnostic.code}</div>}
          {errBody?.diagnostic?.suggestedAction && <div><b>Suggested:</b> {errBody.diagnostic.suggestedAction}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Surfaces the state of the retry queue on the main page. Shows up when the
 * backend has a whatsapp_retry_at for this beautician — usually because a
 * cooldown is active and we've queued an automatic retry.
 */
function RetryBanner({ retry, onReset }) {
  const [secondsLeft, setSecondsLeft] = useState(null);

  useEffect(() => {
    if (!retry?.retry_at) { setSecondsLeft(null); return; }
    const update = () => {
      const diff = new Date(retry.retry_at).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.floor(diff / 1000)));
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [retry?.retry_at]);

  if (!retry) return null;

  const reasonCopy = {
    cooldown_active: 'Meta is still processing this number from a previous attempt.',
    rate_limit: 'Meta is rate-limiting this number right now.',
    pending_activation: "Meta's almost there — just waiting for the number to flip to live.",
    otp_retry_pending: "We're retrying the verification code SMS once Meta clears the temporary block.",
  }[retry.reason] || 'Meta has asked us to wait before retrying.';

  return (
    <div style={styles.retryBanner}>
      <span style={{ fontSize: 20 }}>⏳</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#2E4A6B', marginBottom: 3 }}>
          Auto-retry queued
        </div>
        <div style={{ fontSize: 12, color: '#2E4A6B', lineHeight: 1.5 }}>
          {reasonCopy} {secondsLeft > 0 ? `Retry ${formatCountdown(secondsLeft).replace('Try again ', '')}.` : 'Running now…'}
          {retry.attempts > 0 && ` Attempt ${retry.attempts + 1}.`}
        </div>
      </div>
      <ResetButton onDone={onReset} variant="inline">Cancel</ResetButton>
    </div>
  );
}

/**
 * Full-screen state after /verify says the number is pending activation.
 * Polls /activation-status every 10s until Meta flips it to CONNECTED. Shows
 * a Reset-if-stuck escape hatch after 60s.
 */
function PendingActivation({ phone, onConnected, onReset }) {
  const [metaStatus, setMetaStatus] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const result = await apiFetch('/activation-status');
        if (cancelled) return;
        setMetaStatus(result.metaStatus || result.status);
        if (result.connected) {
          onConnected(phone || result.phone);
          return;
        }
      } catch (err) {
        logger.warn('activation-status poll failed:', err);
      }
    }

    tick();
    const poll = setInterval(tick, 10_000);
    const elapsedT = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(elapsedT);
    };
  }, [phone, onConnected]);

  return (
    <div style={styles.pendingBox}>
      <div style={styles.spinnerWrap}>
        <div style={styles.spinner} />
      </div>
      <h2 style={{ ...styles.connectTitle, marginBottom: 6 }}>
        Bringing your number online
      </h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.6, margin: '0 0 16px' }}>
        Meta's finishing the last step — usually a few minutes, sometimes a bit longer.
        You can close this page and come back, we'll keep watching in the background.
      </p>
      <div style={styles.pendingMeta}>
        <div style={styles.pendingMetaRow}>
          <span>Number</span>
          <b>{phone}</b>
        </div>
        {metaStatus && (
          <div style={styles.pendingMetaRow}>
            <span>Meta status</span>
            <b>{metaStatus}</b>
          </div>
        )}
        <div style={styles.pendingMetaRow}>
          <span>Elapsed time</span>
          <b>{Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, '0')}s</b>
        </div>
      </div>
      {elapsed > 180 ? (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text, #2D2A26)', background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 8, padding: 10, textAlign: 'center' }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>
            Still waiting after 3 minutes? Meta might be having issues.
          </div>
          <ResetButton phone={phone} onDone={onReset} variant="inline">
            Reset and start over
          </ResetButton>
        </div>
      ) : elapsed > 60 && (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted, #AAA5A0)', textAlign: 'center' }}>
          Usually takes a few minutes. If it's taking longer, you can{' '}
          <ResetButton phone={phone} onDone={onReset} variant="inline">
            reset
          </ResetButton>
          {' '}and start again.
        </div>
      )}
    </div>
  );
}

function ConnectFlow({ onConnected, onPending, onReset }) {
  const [step, setStep] = useState('phone'); // 'phone' | 'otp'
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNote, setResendNote] = useState('');
  const [error, setError] = useState(null);
  const [errBody, setErrBody] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  function clearError() {
    setError(null);
    setErrBody(null);
  }

  async function handleRegister(e) {
    e.preventDefault();
    if (!phone.trim()) return;
    clearError();
    setCheckResult(null);
    setLoading(true);
    try {
      await apiFetch('/register', {
        method: 'POST',
        body: JSON.stringify({ phone: phone.trim() }),
      });
      setStep('otp');
      setResendCooldown(30);
    } catch (err) {
      setError(err);
      setErrBody(err.body || null);
    } finally {
      setLoading(false);
    }
  }

  async function handleDiagnose() {
    if (!phone.trim() || checking) return;
    clearError();
    setCheckResult(null);
    setChecking(true);
    try {
      const result = await apiFetch('/preflight', {
        method: 'POST',
        body: JSON.stringify({ phone: phone.trim() }),
      });
      setCheckResult(result);
    } catch (err) {
      setError(err);
      setErrBody(err.body || null);
    } finally {
      setChecking(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    if (!otp.trim()) return;
    clearError();
    setLoading(true);
    try {
      const result = await apiFetch('/verify', {
        method: 'POST',
        body: JSON.stringify({ code: otp.trim() }),
      });
      // Verify now returns one of: connected=true | pendingActivation=true.
      if (result.pendingActivation) {
        onPending(result.phone);
      } else {
        onConnected(result.phone);
      }
    } catch (err) {
      setError(err);
      setErrBody(err.body || null);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || resending) return;
    clearError();
    setResendNote('');
    setResending(true);
    try {
      await apiFetch('/resend-code', { method: 'POST' });
      setResendNote('New code sent, check your messages.');
      setResendCooldown(30);
    } catch (err) {
      setError(err);
      setErrBody(err.body || null);
    } finally {
      setResending(false);
    }
  }

  function handleLocalReset() {
    setStep('phone');
    setOtp('');
    setResendNote('');
    clearError();
    setCheckResult(null);
    onReset?.();
  }

  return (
    <div style={styles.connectBox}>
      <div style={styles.connectIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="#25D366">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.395 5.608L0 24l6.562-1.371A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.623-.527-5.112-1.441l-.363-.216-3.773.99 1.008-3.682-.237-.377A9.697 9.697 0 012.25 12C2.25 6.624 6.624 2.25 12 2.25S21.75 6.624 21.75 12 17.376 21.75 12 21.75z"/>
        </svg>
      </div>

      <h2 style={styles.connectTitle}>Connect WhatsApp</h2>
      <p style={styles.connectDesc}>
        Add your business phone number. Florrie will send booking confirmations,
        reminders, and follow-ups from your number, so clients see messages from you,
        not from a generic platform.
      </p>

      <div style={styles.connectNote}>
        ⚠️ The number must not already be active on personal WhatsApp. Use a business
        number or second SIM. If it is on WhatsApp, delete that account first (you can
        export your chat history beforehand).
      </div>

      {step === 'phone' ? (
        <form onSubmit={handleRegister}>
          <label style={styles.inputLabel}>Your business phone number</label>
          <input
            style={styles.input}
            type="tel"
            placeholder="+44 7700 900000"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            disabled={loading || checking}
          />

          {error && (
            <DiagnosticError
              error={error}
              errBody={errBody}
              onRetry={handleDiagnose}
              onReset={handleLocalReset}
              phone={phone.trim() || null}
            />
          )}

          {checkResult && !error && (
            <div style={{
              ...styles.checkResult,
              background: checkResult.ready ? '#E8F5E9' : '#FFF8E1',
              borderColor: checkResult.ready ? '#C8E6C9' : '#FFE082',
              color: checkResult.ready ? '#2E7D32' : '#7B5E00',
            }}>
              <b>{checkResult.ready ? '✅ Ready to connect' : '⏳ Not ready yet'}</b>
              <div style={{ marginTop: 4 }}>{checkResult.userMessage}</div>
            </div>
          )}

          <button style={styles.connectBtn} type="submit" disabled={loading || checking || !phone.trim()}>
            {loading ? 'Sending code…' : 'Send verification code'}
          </button>

          <button
            type="button"
            style={styles.diagnoseBtn}
            onClick={handleDiagnose}
            disabled={loading || checking || !phone.trim()}
          >
            {checking ? 'Checking…' : "Check status (doesn't send SMS)"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 12 }}>
            Enter the 6-digit code sent to <strong>{phone}</strong>
          </p>
          <label style={styles.inputLabel}>Verification code</label>
          <input
            style={{ ...styles.input, letterSpacing: 6, fontSize: 20, textAlign: 'center' }}
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
            disabled={loading}
            autoFocus
          />
          {error && (
            <DiagnosticError
              error={error}
              errBody={errBody}
              onReset={handleLocalReset}
              phone={phone.trim() || null}
            />
          )}
          {resendNote && <div style={styles.resendNote}>{resendNote}</div>}
          <button style={styles.connectBtn} type="submit" disabled={loading || otp.length < 6}>
            {loading ? 'Verifying…' : 'Confirm'}
          </button>
          <button
            type="button"
            style={styles.resendBtn}
            onClick={handleResend}
            disabled={resending || resendCooldown > 0}
          >
            {resending
              ? 'Sending…'
              : resendCooldown > 0
                ? `Resend code in ${resendCooldown}s`
                : "Didn't get a code? Resend"}
          </button>
          <button
            type="button"
            style={styles.backBtn}
            onClick={() => { setStep('phone'); clearError(); setOtp(''); setResendNote(''); }}
          >
            ← Change number
          </button>
        </form>
      )}
    </div>
  );
}

export default function WhatsAppConfig() {
  const { beautician, loading: bLoading } = useBeautician();
  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [expandedTemplate, setExpandedTemplate] = useState(null);
  const [autoReplies, setAutoReplies] = useState(autoReplyDefaults);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [pendingPhone, setPendingPhone] = useState(null);

  useEffect(() => {
    if (bLoading || !beautician) return;
    loadData();
  }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    try {
      const data = await apiFetch('/status');
      setStatus(data);
      // If the server already knows this beautician is pending activation,
      // jump straight to the polling UI. This handles the "closed the tab"
      // and "came back a few minutes later" cases.
      if (!data.connected && data.pending_activation) {
        setPendingPhone(data.pending_phone || data.phone);
      } else {
        setPendingPhone(null);
      }
    } catch (err) {
      logger.error('WhatsApp load error:', err);
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect WhatsApp? Automated messages will stop.')) return;
    setDisconnecting(true);
    try {
      await apiFetch('/disconnect', { method: 'DELETE' });
      setStatus({ connected: false });
      setPendingPhone(null);
    } catch (err) {
      alert('Something went wrong, try again');
    } finally {
      setDisconnecting(false);
    }
  }

  function handleConnected(phone) {
    setStatus(prev => ({ ...prev, connected: true, phone, pending_activation: false, retry: null }));
    setPendingPhone(null);
  }

  function handlePending(phone) {
    setPendingPhone(phone);
    setStatus(prev => ({ ...prev, connected: false, pending_activation: true, pending_phone: phone }));
  }

  async function handleReset() {
    // After a reset, reload status from scratch so banners clear cleanly.
    setPendingPhone(null);
    await loadData();
  }

  if (bLoading || loading) return <PageLoader />;

  const connected = status?.connected;
  const pendingActivation = !!status?.pending_activation || !!pendingPhone;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'templates', label: 'Templates' },
    { id: 'autoreplies', label: 'Auto-reply' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>WhatsApp Business</h1>
        <div style={{
          ...styles.statusBadge,
          background: connected
            ? 'var(--success-bg, #EDF7F0)'
            : pendingActivation ? '#EDF3FA' : '#FFF3E0',
          color: connected
            ? 'var(--success, #5BA97B)'
            : pendingActivation ? '#2E4A6B' : '#E65100',
        }}>
          {connected ? '🟢 Connected' : pendingActivation ? '⏳ Activating' : '🔴 Not connected'}
        </div>
      </div>

      {/* Retry exhausted — shown when retry worker has given up after max attempts */}
      {!connected && !pendingActivation && status?.retry_exhausted && (
        <div style={{
          background: '#FDECEA',
          border: '1px solid #F5C6C0',
          borderRadius: 14,
          padding: 14,
          marginBottom: 14,
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>❌</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#8A2A1C', marginBottom: 6 }}>
              We've tried 8 times — time for support
            </div>
            <div style={{ fontSize: 12, color: '#8A2A1C', lineHeight: 1.5, marginBottom: 10 }}>
              We've automatically retried this connection multiple times without success.
              This usually means Meta needs to investigate your account directly.
              Please contact support with your phone number and we'll escalate it.
            </div>
            <button
              onClick={handleReset}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid #F5C6C0',
                background: '#fff',
                color: '#8A2A1C',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Clear and try again
            </button>
          </div>
        </div>
      )}

      {/* Retry queue banner — shown whenever /status reports a queued retry */}
      {!connected && !pendingActivation && status?.retry && !status?.retry_exhausted && (
        <RetryBanner retry={status.retry} onReset={handleReset} />
      )}

      {/* Pending activation — polling Meta until CONNECTED */}
      {!connected && pendingActivation && (
        <PendingActivation
          phone={pendingPhone || status?.pending_phone || status?.phone}
          onConnected={handleConnected}
          onReset={handleReset}
        />
      )}

      {/* Not connected and nothing in flight — show setup flow */}
      {!connected && !pendingActivation && (
        <ConnectFlow
          onConnected={handleConnected}
          onPending={handlePending}
          onReset={handleReset}
        />
      )}

      {connected && (
        <>
          <div style={styles.connectionCard}>
            <div style={styles.waLogo}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.395 5.608L0 24l6.562-1.371A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.623-.527-5.112-1.441l-.363-.216-3.773.99 1.008-3.682-.237-.377A9.697 9.697 0 012.25 12C2.25 6.624 6.624 2.25 12 2.25S21.75 6.624 21.75 12 17.376 21.75 12 21.75z"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>
                {status?.business_name || beautician?.business_name || 'Your Business'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted, #AAA5A0)' }}>{status?.phone}</div>
            </div>
            <div style={styles.metaBadge}>Meta Cloud API</div>
          </div>

          <UsageBar usage={status?.usage} />

          <div style={styles.tabs}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{ ...styles.tab, ...(activeTab === tab.id ? styles.tabActive : {}) }}
              >{tab.label}</button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div>
              <div style={styles.statsRow}>
                <div style={styles.statCard}>
                  <div style={styles.statValue}>{status?.usage?.whatsapp_sent ?? 0}</div>
                  <div style={styles.statLabel}>WhatsApp sent</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statValue}>{status?.usage?.sms_sent ?? 0}</div>
                  <div style={styles.statLabel}>SMS sent</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statValue}>{status?.usage?.remaining ?? '—'}</div>
                  <div style={styles.statLabel}>Remaining</div>
                </div>
              </div>

              <div style={styles.funnelCard}>
                <div style={styles.funnelTitle}>Monthly usage breakdown</div>
                {[
                  { label: 'WhatsApp', value: status?.usage?.whatsapp_sent ?? 0, max: status?.usage?.free_limit ?? 120, color: '#25D366' },
                  { label: 'SMS', value: status?.usage?.sms_sent ?? 0, max: status?.usage?.free_limit ?? 120, color: '#007AFF' },
                ].map((row, i) => (
                  <div key={i} style={styles.funnelRow}>
                    <div style={styles.funnelLabel}>{row.label}</div>
                    <div style={styles.funnelBarBg}>
                      <div style={{ ...styles.funnelBarFill, width: `${Math.min(100, Math.round((row.value / row.max) * 100))}%`, background: row.color }} />
                    </div>
                    <div style={styles.funnelValue}>{row.value}</div>
                  </div>
                ))}
              </div>

              <div style={styles.insightCard}>
                <span style={{ fontSize: 16 }}>💡</span>
                <div style={{ fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5 }}>
                  120 messages/month included in your plan across SMS and WhatsApp combined.
                  Extra messages are billed at 5p (WhatsApp) or 6p (SMS) each.
                </div>
              </div>
            </div>
          )}

          {activeTab === 'templates' && (
            <div>
              <button style={styles.newTemplateBtn}>+ Create Template</button>
              {templates.map(tmpl => (
                <div key={tmpl.id} style={styles.templateCard}>
                  <div
                    style={styles.templateHeader}
                    onClick={() => setExpandedTemplate(expandedTemplate === tmpl.id ? null : tmpl.id)}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={styles.templateName}>{tmpl.name}</span>
                        <span style={{
                          ...styles.tmplStatus,
                          background: tmpl.status === 'approved' ? '#E8F5E9' : '#FFF8E1',
                          color: tmpl.status === 'approved' ? '#2E7D32' : '#F57F17',
                        }}>{tmpl.status}</span>
                        <span style={styles.tmplCategory}>{tmpl.category}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>
                        Used {tmpl.uses} times · Last: {tmpl.lastUsed}
                      </div>
                    </div>
                    <span style={{ fontSize: 18, color: 'var(--text-muted, #AAA5A0)' }}>
                      {expandedTemplate === tmpl.id ? '▾' : '▸'}
                    </span>
                  </div>
                  {expandedTemplate === tmpl.id && (
                    <div style={styles.templatePreview}>
                      <div style={styles.previewBubble}>{tmpl.preview}</div>
                      <div style={styles.previewActions}>
                        <button style={styles.previewBtn}>✏️ Edit</button>
                        <button style={styles.previewBtn}>📋 Duplicate</button>
                        <button style={styles.previewBtn}>🧪 Test Send</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'autoreplies' && (
            <div>
              <div style={styles.autoReplyHint}>
                Florrie reads incoming messages and auto-responds when it's confident about the intent.
                Customise these or let Florrie draft replies in your tone.
              </div>
              {autoReplies.map(rule => (
                <div key={rule.id} style={styles.autoReplyCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' }}>{rule.trigger}</div>
                    <button
                      onClick={() => setAutoReplies(autoReplies.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}
                      style={{ ...styles.toggle, background: rule.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)' }}
                    >
                      <div style={{ ...styles.toggleDot, transform: rule.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
                    </button>
                  </div>
                  {rule.response ? (
                    <div style={styles.autoReplyPreview}>{rule.response}</div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', fontStyle: 'italic' }}>
                      No auto-reply, messages go to Inbox for manual response
                    </div>
                  )}
                </div>
              ))}

              <div style={styles.aiToggleCard}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)', marginBottom: 4 }}>🧠 Florrie AI Drafting</div>
                  <div style={{ fontSize: 12, color: '#6B6560', lineHeight: 1.4 }}>
                    Let Florrie draft replies to unmatched messages in your tone. Drafts appear in Inbox for approval before sending.
                  </div>
                </div>
                <button style={{ ...styles.toggle, background: 'var(--accent, #C76B8A)' }}>
                  <div style={{ ...styles.toggleDot, transform: 'translateX(18px)' }} />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div>
              {[
                { label: 'Business hours messaging', desc: 'Only send automated messages during your set business hours', enabled: true },
                { label: 'Read receipts', desc: 'Track when clients read your messages', enabled: true },
                { label: 'Typing indicator', desc: 'Show typing indicator before auto-replies', enabled: false },
                { label: 'Message rate limiting', desc: 'Max 3 automated messages per client per day', enabled: true },
                { label: 'Opt-out handling', desc: 'Auto-detect STOP/unsubscribe and disable messaging', enabled: true },
                { label: 'Conversation backup', desc: 'Save all conversations to client timeline', enabled: true },
              ].map((setting, i) => (
                <div key={i} style={styles.settingRow}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' }}>{setting.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 }}>{setting.desc}</div>
                  </div>
                  <button style={{ ...styles.toggle, background: setting.enabled ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)' }}>
                    <div style={{ ...styles.toggleDot, transform: setting.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
                  </button>
                </div>
              ))}

              <div style={styles.dangerZone}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#E85D75', marginBottom: 8 }}>Danger zone</div>
                <p style={{ fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, margin: '0 0 12px' }}>
                  <b>Reset</b> wipes the connection on both our side and Meta's, so you can start from scratch if a connection's stuck.
                  <b> Disconnect</b> just stops Florrie sending messages from this number.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <ResetButton
                    phone={status?.phone}
                    onDone={handleReset}
                    variant="danger"
                  >
                    Reset with Meta
                  </ResetButton>
                  <button
                    style={styles.disconnectBtn}
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect WhatsApp'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  statusBadge: { padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600 },

  connectBox: { background: 'var(--bg-card, #fff)', borderRadius: 18, padding: 24, border: '1px solid var(--border, #F0ECE8)' },
  connectIcon: { width: 56, height: 56, borderRadius: 16, background: 'var(--success-bg, #EDF7F0)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  connectTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 8px' },
  connectDesc: { fontSize: 14, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.6, margin: '0 0 14px' },
  connectNote: { fontSize: 12, color: '#7B5E00', background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 10, padding: 12, marginBottom: 20, lineHeight: 1.5 },
  inputLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 6 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 12, border: '1.5px solid var(--border, #E8E4E0)', fontSize: 15, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--bg, #FAF8F5)', outline: 'none', boxSizing: 'border-box', marginBottom: 12 },
  connectBtn: { width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', background: '#25D366', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  diagnoseBtn: { width: '100%', padding: '11px 0', borderRadius: 12, border: '1px solid var(--border, #E8E4E0)', background: 'var(--bg, #FAF8F5)', color: 'var(--text-secondary, #8B6F5E)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginTop: 10 },
  checkResult: { fontSize: 13, border: '1px solid', borderRadius: 10, padding: 12, marginBottom: 12, lineHeight: 1.5 },
  backBtn: { width: '100%', padding: '10px 0', borderRadius: 12, border: 'none', background: 'none', color: 'var(--text-muted, #AAA5A0)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },
  resendBtn: { width: '100%', padding: '10px 0', borderRadius: 12, border: '1px solid var(--border, #E8E4E0)', background: 'var(--bg, #FAF8F5)', color: 'var(--text-secondary, #8B6F5E)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginTop: 10 },
  resendNote: { fontSize: 12, color: '#2E7D32', background: '#E8F5E9', border: '1px solid #C8E6C9', borderRadius: 10, padding: '8px 12px', marginBottom: 10 },
  errorMsg: { fontSize: 13, color: '#E85D75', marginBottom: 10 },

  retryBanner: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    background: '#EDF3FA',
    border: '1px solid #CFD8E5',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },

  pendingBox: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 18,
    padding: 28,
    border: '1px solid var(--border, #F0ECE8)',
    textAlign: 'center',
  },
  spinnerWrap: { display: 'flex', justifyContent: 'center', marginBottom: 18 },
  spinner: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '4px solid #E8E4E0',
    borderTopColor: '#25D366',
    animation: 'wa-spin 0.9s linear infinite',
  },
  pendingMeta: {
    background: 'var(--bg, #FAF8F5)',
    borderRadius: 12,
    padding: '10px 14px',
    marginTop: 6,
    textAlign: 'left',
  },
  pendingMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: 13,
    color: 'var(--text-secondary, #8B6F5E)',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },

  usageBar: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '12px 14px', border: '1px solid var(--border, #F0ECE8)', marginBottom: 12 },

  connectionCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 12 },
  waLogo: { width: 44, height: 44, borderRadius: 12, background: 'var(--success-bg, #EDF7F0)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  metaBadge: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', background: 'var(--border, #F0ECE8)', padding: '3px 8px', borderRadius: 6 },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: 'var(--border, #F0ECE8)', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: 'var(--text-secondary, #8B6F5E)' },
  tabActive: { background: 'var(--bg-card, #fff)', color: 'var(--text, #2D2A26)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 14, border: '1px solid var(--border, #F0ECE8)', textAlign: 'center' },
  statValue: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },

  funnelCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, border: '1px solid var(--border, #F0ECE8)', marginBottom: 16 },
  funnelTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 12 },
  funnelRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  funnelLabel: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', width: 60 },
  funnelBarBg: { flex: 1, height: 8, background: 'var(--border, #F0ECE8)', borderRadius: 4 },
  funnelBarFill: { height: '100%', borderRadius: 4, transition: 'width 0.5s' },
  funnelValue: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)', width: 36, textAlign: 'right' },

  insightCard: { display: 'flex', gap: 10, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 12, padding: 14, marginBottom: 16 },

  newTemplateBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: '2px dashed var(--border, #E8E4E0)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 },
  templateCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 8, overflow: 'hidden' },
  templateHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: 14, cursor: 'pointer' },
  templateName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  tmplStatus: { fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 6 },
  tmplCategory: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', background: 'var(--border, #F0ECE8)', padding: '2px 6px', borderRadius: 6 },
  templatePreview: { padding: '0 14px 14px', borderTop: '1px solid var(--border, #F0ECE8)' },
  previewBubble: { background: 'var(--success-bg, #EDF7F0)', borderRadius: '12px 12px 12px 0', padding: 12, fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.5, marginTop: 12, marginBottom: 10 },
  previewActions: { display: 'flex', gap: 8 },
  previewBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border, #F0ECE8)', background: 'var(--bg, #FAF8F5)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary, #8B6F5E)' },

  autoReplyHint: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, marginBottom: 16, background: 'var(--bg, #FAF8F5)', padding: 12, borderRadius: 12 },
  autoReplyCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)', marginBottom: 10 },
  autoReplyPreview: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 10 },
  aiToggleCard: { display: 'flex', alignItems: 'center', gap: 12, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 14, padding: 14, marginTop: 16 },

  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },

  settingRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--border, #F0ECE8)' },
  dangerZone: { marginTop: 24, padding: 16, background: 'var(--danger-bg, #FDF0EF)', borderRadius: 14, border: '1px solid var(--danger, #D4605C)' },
  disconnectBtn: { padding: '10px 16px', borderRadius: 10, border: '1px solid var(--danger, #D4605C)', background: 'none', color: 'var(--danger, #D4605C)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};

// Spinner keyframes injected once so the <PendingActivation> spinner animates
// without needing a global stylesheet.
if (typeof document !== 'undefined' && !document.getElementById('wa-spin-keyframes')) {
  const st = document.createElement('style');
  st.id = 'wa-spin-keyframes';
  st.textContent = '@keyframes wa-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(st);
}
