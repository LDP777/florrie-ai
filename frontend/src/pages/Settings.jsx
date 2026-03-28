import { useState } from 'react';
import { useBeautician, updateRow, supabase } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';

/**
 * Settings — beautician profile and app configuration.
 * Wired to Supabase via useBeautician. Ellie's real hours + tone model as defaults.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Settings({ onLogout }) {
  const { beautician, loading, refresh } = useBeautician();
  const { isDark, toggle: toggleDark } = useTheme();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [section, setSection] = useState('profile');

  async function saveProfile(updates) {
    if (!beautician) return;
    setSaving(true);
    setSaved(false);
    try {
      await updateRow('beauticians', beautician.id, updates);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    if (supabase) await supabase.auth.signOut();
    if (onLogout) onLogout();
  }

  if (loading) return <p style={styles.loadingText}>Loading settings...</p>;
  if (!beautician) return <p style={styles.loadingText}>Could not load profile.</p>;

  const hours = beautician.working_hours || {};
  const tone = beautician.tone_model || {};
  const confidence = beautician.confidence_threshold || 0.85;

  return (
    <div style={{ ...styles.page, animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}>
      <div style={styles.header}>
        <h1 style={styles.title}>Settings</h1>
        {saved && <span style={styles.savedBadge}>Saved</span>}
      </div>

      {/* Section nav */}
      <div style={styles.sectionNav}>
        {[
          { key: 'profile', label: 'Profile' },
          { key: 'hours', label: 'Hours' },
          { key: 'payments', label: 'Payments' },
          { key: 'calendar', label: 'Calendar' },
          { key: 'notifications', label: 'Alerts' },
          { key: 'ai', label: 'AI' },
          { key: 'account', label: 'Account' }
        ].map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            style={{
              ...styles.sectionTab,
              background: section === s.key ? 'var(--accent)' : 'var(--border-light)',
              color: section === s.key ? 'var(--bg-card)' : 'var(--text-secondary)'
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* === PROFILE === */}
      {section === 'profile' && (
        <div style={styles.card}>
          <FieldEditor label="First name" value={beautician.first_name} onSave={v => saveProfile({ first_name: v })} />
          <FieldEditor label="Last name" value={beautician.last_name || ''} onSave={v => saveProfile({ last_name: v })} />
          <FieldEditor label="Business name" value={beautician.business_name || ''} onSave={v => saveProfile({ business_name: v })} />
          <FieldEditor label="Phone" value={beautician.phone || ''} onSave={v => saveProfile({ phone: v })} />

          {/* Booking link — shareable */}
          {beautician.booking_slug ? (
            <BookingLinkCard slug={beautician.booking_slug} />
          ) : (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Booking link</span>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Set a booking slug below to get your link</span>
            </div>
          )}
          <FieldEditor
            label="Booking slug"
            value={beautician.booking_slug || ''}
            onSave={v => saveProfile({ booking_slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          />
        </div>
      )}

      {/* === WORKING HOURS === */}
      {section === 'hours' && (
        <div style={styles.card}>
          <p style={styles.cardDesc}>Set when clients can book appointments.</p>
          {DAY_KEYS.map((day, idx) => {
            const dayHours = hours[day];
            const enabled = !!dayHours;
            return (
              <div key={day} style={styles.dayRow}>
                <label style={styles.dayToggle}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => {
                      const newHours = { ...hours };
                      if (enabled) { newHours[day] = null; } else { newHours[day] = { start: '09:00', end: '17:00' }; }
                      saveProfile({ working_hours: newHours });
                    }}
                  />
                  <span style={{ ...styles.dayName, color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {DAYS[idx]}
                  </span>
                </label>
                {enabled && (
                  <div style={styles.timeInputs}>
                    <input type="time" value={dayHours?.start || '09:00'} onChange={e => { const nh = { ...hours, [day]: { ...hours[day], start: e.target.value } }; saveProfile({ working_hours: nh }); }} style={styles.timeInput} />
                    <span style={styles.timeSep}>to</span>
                    <input type="time" value={dayHours?.end || '17:00'} onChange={e => { const nh = { ...hours, [day]: { ...hours[day], end: e.target.value } }; saveProfile({ working_hours: nh }); }} style={styles.timeInput} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* === PAYMENTS (STRIPE) === */}
      {section === 'payments' && (
        <div>
          {/* Connection status */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Stripe Connect</div>
            <div style={styles.connectionStatus}>
              <div style={{
                ...styles.statusDot,
                background: beautician.stripe_onboarding_complete ? 'var(--success)' : 'var(--warning)',
              }} />
              <span style={styles.connectionLabel}>
                {beautician.stripe_onboarding_complete ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <p style={styles.cardHint}>
              {beautician.stripe_onboarding_complete
                ? 'Card payments are live. Clients can pay online and via Tap to Pay.'
                : 'Connect Stripe to accept card payments, deposits, and no-show fees.'}
            </p>
            {!beautician.stripe_onboarding_complete && (
              <button style={styles.connectBtn}>
                Connect Stripe
              </button>
            )}
          </div>

          {/* Subscription management */}
          {beautician.stripe_customer_id && (
            <SubscriptionManager beautician={beautician} />
          )}

          {/* Payment methods */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Accepted payment methods</div>
            {[
              { key: 'card_online', label: 'Card online', desc: 'Clients pay when booking', icon: '💳' },
              { key: 'tap_to_pay', label: 'Tap to Pay', desc: 'Use your phone as a card terminal', icon: '📱' },
              { key: 'cash', label: 'Cash', desc: 'Record cash payments manually', icon: '💵' },
              { key: 'bank_transfer', label: 'Bank transfer', desc: 'BACS or faster payment', icon: '🏦' },
            ].map(method => (
              <div key={method.key} style={styles.paymentMethodRow}>
                <span style={{ fontSize: 18 }}>{method.icon}</span>
                <div style={{ flex: 1 }}>
                  <span style={styles.methodLabel}>{method.label}</span>
                  <span style={styles.methodDesc}>{method.desc}</span>
                </div>
                <div
                  style={{
                    ...styles.toggle,
                    background: method.key === 'cash' || beautician.stripe_onboarding_complete ? '#C76B8A' : '#E0DBD5',
                  }}
                >
                  <div style={{
                    ...styles.toggleDot,
                    transform: method.key === 'cash' || beautician.stripe_onboarding_complete ? 'translateX(16px)' : 'translateX(0)',
                  }} />
                </div>
              </div>
            ))}
          </div>

          {/* Deposits & no-show fees */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Deposits & no-show fees</div>

            <div style={styles.depositRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.depositLabel}>Require deposit</span>
                <span style={styles.depositHint}>Clients pay upfront when booking</span>
              </div>
              <div style={{ ...styles.toggle, background: 'var(--accent)' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.depositAmountRow}>
              <span style={styles.depositAmountLabel}>Deposit amount</span>
              <div style={styles.depositOptions}>
                {['£5', '£10', '£15', '50%'].map(opt => (
                  <button
                    key={opt}
                    style={{
                      ...styles.depositChip,
                      background: opt === '£10' ? '#C76B8A' : '#F5F2EF',
                      color: opt === '£10' ? '#fff' : '#8A8580',
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div style={styles.depositRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.depositLabel}>No-show fee</span>
                <span style={styles.depositHint}>Charge clients who don't show up</span>
              </div>
              <div style={{ ...styles.toggle, background: 'var(--accent)' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <p style={styles.depositFooter}>
              No-show fees are set per treatment in your Treatments page. The deposit covers the fee.
            </p>
          </div>

          {/* Payout info */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Payouts</div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Schedule</span>
              <span style={styles.payoutValue}>Daily (arrives next business day)</span>
            </div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Fees</span>
              <span style={styles.payoutValue}>1.4% + 20p per transaction</span>
            </div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Account</span>
              <span style={styles.payoutValue}>{beautician.stripe_onboarding_complete ? '••••6742' : 'Not linked'}</span>
            </div>
          </div>
        </div>
      )}

      {/* === CALENDAR SYNC === */}
      {section === 'calendar' && (
        <div>
          <div style={styles.card}>
            <div style={styles.cardTitle}>Calendar sync</div>
            <p style={styles.cardHint}>
              Connect your calendar so florrie.ai can check availability and avoid double-bookings.
            </p>
          </div>

          {/* Google Calendar */}
          <div style={styles.card}>
            <div style={styles.calendarProviderRow}>
              <span style={{ fontSize: 22 }}>📅</span>
              <div style={{ flex: 1 }}>
                <span style={styles.calProviderLabel}>Google Calendar</span>
                <span style={styles.calProviderStatus}>Not connected</span>
              </div>
              <button style={styles.connectBtn}>Connect</button>
            </div>
          </div>

          {/* Apple Calendar */}
          <div style={styles.card}>
            <div style={styles.calendarProviderRow}>
              <span style={{ fontSize: 22 }}>🍎</span>
              <div style={{ flex: 1 }}>
                <span style={styles.calProviderLabel}>Apple Calendar</span>
                <span style={styles.calProviderStatus}>Not connected</span>
              </div>
              <button style={styles.connectBtn}>Connect</button>
            </div>
          </div>

          {/* Sync settings */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Sync behaviour</div>

            <div style={styles.syncRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.syncLabel}>Block personal events</span>
                <span style={styles.syncHint}>Personal calendar events block booking slots</span>
              </div>
              <div style={{ ...styles.toggle, background: 'var(--accent)' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.syncRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.syncLabel}>Push bookings to calendar</span>
                <span style={styles.syncHint}>New bookings appear in your connected calendar</span>
              </div>
              <div style={{ ...styles.toggle, background: 'var(--accent)' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(16px)' }} />
              </div>
            </div>

            <div style={styles.syncRow}>
              <div style={{ flex: 1 }}>
                <span style={styles.syncLabel}>Two-way sync</span>
                <span style={styles.syncHint}>Changes in either calendar stay in sync</span>
              </div>
              <div style={{ ...styles.toggle, background: 'var(--border)' }}>
                <div style={{ ...styles.toggleDot, transform: 'translateX(0)' }} />
              </div>
            </div>
          </div>

          {/* Buffer time */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Buffer time</div>
            <p style={styles.cardHint}>Gap between appointments for cleanup and prep.</p>
            <div style={styles.bufferOptions}>
              {['None', '5 min', '10 min', '15 min', '30 min'].map(opt => (
                <button
                  key={opt}
                  style={{
                    ...styles.bufferChip,
                    background: opt === '10 min' ? '#C76B8A' : '#F5F2EF',
                    color: opt === '10 min' ? '#fff' : '#8A8580',
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* === NOTIFICATIONS === */}
      {section === 'notifications' && (
        <div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Your notifications</h3>
            <p style={styles.cardDesc}>Choose how you want to be notified about activity.</p>
            <NotificationToggle
              label="New bookings"
              desc="When a client books an appointment"
              prefs={beautician.notification_prefs?.booking_confirmed || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), booking_confirmed: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Cancellations"
              desc="When a client cancels"
              prefs={beautician.notification_prefs?.booking_cancelled || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), booking_cancelled: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="AI escalations"
              desc="When the AI isn't sure and needs you"
              prefs={beautician.notification_prefs?.ai_escalation || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), ai_escalation: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Payment received"
              desc="When you get paid"
              prefs={beautician.notification_prefs?.payment_received || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), payment_received: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Weekly digest"
              desc="Summary of your week every Monday"
              prefs={beautician.notification_prefs?.weekly_digest || { email: true, push: false }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), weekly_digest: v };
                saveProfile({ notification_prefs: np });
              }}
            />
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Client reminders</h3>
            <p style={styles.cardDesc}>What your clients receive automatically.</p>
            <ClientReminderRow
              label="Booking confirmation"
              enabled={beautician.client_reminder_prefs?.booking_confirmation !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), booking_confirmation: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="24-hour reminder"
              enabled={beautician.client_reminder_prefs?.reminder_24h !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), reminder_24h: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="1-hour reminder"
              enabled={beautician.client_reminder_prefs?.reminder_1h || false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), reminder_1h: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="Aftercare follow-up"
              enabled={beautician.client_reminder_prefs?.aftercare_followup !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), aftercare_followup: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="Smart rebook nudge"
              enabled={beautician.client_reminder_prefs?.rebook_nudge !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), rebook_nudge: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <div style={styles.channelPicker}>
              <span style={styles.channelLabel}>Send via</span>
              <div style={styles.channelOptions}>
                {['whatsapp', 'email', 'sms'].map(ch => (
                  <button
                    key={ch}
                    onClick={() => {
                      const rp = { ...(beautician.client_reminder_prefs || {}), channel: ch };
                      saveProfile({ client_reminder_prefs: rp });
                    }}
                    style={{
                      ...styles.channelChip,
                      background: (beautician.client_reminder_prefs?.channel || 'whatsapp') === ch ? '#C76B8A' : '#F5F2EF',
                      color: (beautician.client_reminder_prefs?.channel || 'whatsapp') === ch ? '#fff' : '#8A8580'
                    }}
                  >
                    {ch === 'whatsapp' ? '💬 WhatsApp' : ch === 'email' ? '📧 Email' : '📱 SMS'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* === AI SETTINGS === */}
      {section === 'ai' && (
        <div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Auto-reply</h3>
            <p style={styles.cardDesc}>
              When enabled, the AI Front Desk answers messages automatically when it's confident enough.
              Messages below the confidence threshold get escalated to you.
            </p>

            <div style={styles.toggleRow}>
              <span style={styles.toggleLabel}>Auto-reply enabled</span>
              <button
                onClick={() => saveProfile({ auto_reply_enabled: !beautician.auto_reply_enabled })}
                style={{ ...styles.toggle, background: beautician.auto_reply_enabled ? 'var(--accent)' : 'var(--border)' }}
              >
                <div style={{ ...styles.toggleDot, transform: beautician.auto_reply_enabled ? 'translateX(20px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={styles.sliderSection}>
              <div style={styles.sliderHeader}>
                <span style={styles.sliderLabel}>Confidence threshold</span>
                <span style={styles.sliderValue}>{Math.round(confidence * 100)}%</span>
              </div>
              <input type="range" min="0.5" max="1.0" step="0.05" value={confidence} onChange={e => saveProfile({ confidence_threshold: parseFloat(e.target.value) })} style={styles.slider} />
              <div style={styles.sliderHints}>
                <span>More autonomous</span>
                <span>More cautious</span>
              </div>
            </div>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Tone model</h3>
            <p style={styles.cardDesc}>
              {tone.corrections_count
                ? `The AI has learned from ${tone.corrections_count} corrections.`
                : 'Trained from your real messaging style. The AI uses your greetings, sign-offs, and emoji habits.'}
            </p>
            {tone.greeting_style && <ToneRow label="Greeting" value={tone.greeting_style} />}
            {tone.sign_off_style && <ToneRow label="Sign-off" value={tone.sign_off_style} />}
            {tone.emoji_usage && <ToneRow label="Emojis" value={tone.emoji_usage} />}
            {tone.formality && <ToneRow label="Formality" value={tone.formality} />}
            {tone.key_phrases?.length > 0 && <ToneRow label="Key phrases" value={tone.key_phrases.join(', ')} />}
            {tone.avoid?.length > 0 && <ToneRow label="Avoids" value={tone.avoid.join(', ')} />}
          </div>
        </div>
      )}

      {/* === ACCOUNT === */}
      {section === 'account' && (
        <div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Subscription</h3>
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Plan</span>
              <span style={styles.fieldValue}>
                {beautician.subscription_status === 'trial' ? '14-day free trial' :
                 beautician.subscription_status === 'active' ? 'Active (£50/mo)' :
                 beautician.subscription_status || 'Trial'}
              </span>
            </div>
            {beautician.trial_ends_at && (
              <div style={styles.fieldRow}>
                <span style={styles.fieldLabel}>Trial ends</span>
                <span style={styles.fieldValue}>
                  {new Date(beautician.trial_ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              </div>
            )}
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Email</span>
              <span style={styles.fieldValue}>{beautician.email}</span>
            </div>
          </div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Appearance</h3>
            <div style={styles.toggleRow}>
              <span style={styles.toggleLabel}>{isDark ? '🌙 Dark mode' : '☀️ Light mode'}</span>
              <button
                onClick={toggleDark}
                style={{ ...styles.toggle, background: isDark ? 'var(--accent)' : 'var(--border)' }}
              >
                <div style={{ ...styles.toggleDot, transform: isDark ? 'translateX(20px)' : 'translateX(2px)' }} />
              </button>
            </div>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function ToneRow({ label, value }) {
  return (
    <div style={styles.toneItem}>
      <span style={styles.toneLabel}>{label}</span>
      <span style={styles.toneValue}>{value}</span>
    </div>
  );
}

function FieldEditor({ label, value, onSave, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function handleSave() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  return (
    <div style={styles.fieldRow}>
      <span style={styles.fieldLabel}>{label}</span>
      {editing ? (
        <input type="text" value={draft} onChange={e => setDraft(e.target.value)} onBlur={handleSave} onKeyDown={e => e.key === 'Enter' && handleSave()} placeholder={placeholder} style={styles.fieldInput} autoFocus />
      ) : (
        <button onClick={() => { setDraft(value); setEditing(true); }} style={styles.fieldValue}>
          {value || <span style={{ color: '#D5D0CB' }}>{placeholder || 'Tap to set'}</span>}
        </button>
      )}
    </div>
  );
}

function NotificationToggle({ label, desc, prefs, onChange }) {
  return (
    <div style={styles.notifRow}>
      <div style={styles.notifInfo}>
        <span style={styles.notifLabel}>{label}</span>
        <span style={styles.notifDesc}>{desc}</span>
      </div>
      <div style={styles.notifChannels}>
        <button
          onClick={() => onChange({ ...prefs, email: !prefs.email })}
          style={{
            ...styles.notifChip,
            background: prefs.email ? 'var(--success-bg)' : 'var(--border-light)',
            color: prefs.email ? 'var(--success)' : 'var(--text-muted)'
          }}
        >
          📧
        </button>
        <button
          onClick={() => onChange({ ...prefs, push: !prefs.push })}
          style={{
            ...styles.notifChip,
            background: prefs.push ? 'var(--success-bg)' : 'var(--border-light)',
            color: prefs.push ? 'var(--success)' : 'var(--text-muted)'
          }}
        >
          🔔
        </button>
      </div>
    </div>
  );
}

function ClientReminderRow({ label, enabled, onChange }) {
  return (
    <div style={styles.reminderRow}>
      <span style={styles.reminderLabel}>{label}</span>
      <button
        onClick={() => onChange(!enabled)}
        style={{ ...styles.toggle, background: enabled ? 'var(--accent)' : 'var(--border)', width: 44, height: 24 }}
      >
        <div style={{ ...styles.toggleDot, transform: enabled ? 'translateX(20px)' : 'translateX(2px)' }} />
      </button>
    </div>
  );
}

function BookingLinkCard({ slug }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/book/${slug}`;

  function handleCopy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleShare() {
    if (navigator.share) {
      navigator.share({
        title: 'Book an appointment',
        text: 'Book your next appointment with me!',
        url: url
      }).catch(() => {});
    } else {
      handleCopy();
    }
  }

  return (
    <div style={styles.bookingLinkCard}>
      <div style={styles.bookingLinkHeader}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your booking link</span>
      </div>
      <div style={styles.bookingLinkUrl}>
        <span style={{ fontSize: 14, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{url}</span>
      </div>
      <div style={styles.bookingLinkActions}>
        <button onClick={handleCopy} style={styles.bookingLinkBtn}>
          {copied ? '✓ Copied!' : '📋 Copy link'}
        </button>
        <button onClick={handleShare} style={{ ...styles.bookingLinkBtn, background: 'var(--accent)', color: 'var(--bg-card)' }}>
          📤 Share
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
        Add this link to your Instagram bio, WhatsApp status, or send it directly to clients
      </p>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)', fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)", padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 28, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", letterSpacing: '-0.02em' },
  savedBadge: { padding: '4px 10px', borderRadius: 6, background: 'var(--success-bg)', color: 'var(--success)', fontSize: 12, fontWeight: 600 },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14, fontFamily: "var(--font-body, 'DM Sans', sans-serif)" },
  sectionNav: { display: 'flex', gap: 6, marginBottom: 16 },
  sectionTab: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },
  card: { background: 'var(--bg-card)', borderRadius: 14, padding: 16, marginBottom: 12, boxShadow: 'var(--shadow-sm)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-primary)' },
  cardDesc: { fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.5 },
  fieldRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  fieldLabel: { fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 },
  fieldValue: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'right', padding: 0 },
  fieldInput: { fontSize: 13, fontWeight: 500, fontFamily: 'inherit', textAlign: 'right', border: 'none', borderBottom: '1.5px solid var(--accent)', outline: 'none', padding: '2px 0', background: 'transparent', color: 'var(--text-primary)' },
  bookingLinkCard: { background: 'var(--accent-light)', borderRadius: 12, padding: 16, marginBottom: 8, border: '1.5px solid rgba(199, 107, 138, 0.2)' },
  bookingLinkHeader: { marginBottom: 8 },
  bookingLinkUrl: { background: 'var(--bg-card)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 },
  bookingLinkActions: { display: 'flex', gap: 8 },
  bookingLinkBtn: { flex: 1, padding: '10px 0', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: '#444', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  slugDisplay: { display: 'flex', alignItems: 'center', gap: 2 },
  slugPrefix: { fontSize: 12, color: 'var(--text-muted)' },
  slugValue: { fontSize: 13, fontWeight: 600, color: 'var(--accent)' },
  dayRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  dayToggle: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  dayName: { fontSize: 14, fontWeight: 500 },
  timeInputs: { display: 'flex', alignItems: 'center', gap: 6 },
  timeInput: { padding: '5px 6px', borderRadius: 6, border: '1.5px solid var(--border)', fontSize: 12, fontFamily: 'inherit', outline: 'none', width: 80 },
  timeSep: { fontSize: 11, color: 'var(--text-muted)' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  toggleLabel: { fontSize: 13, fontWeight: 500 },
  toggle: { width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card)', transition: 'transform 0.2s', position: 'absolute', top: 2 },
  sliderSection: { padding: '14px 0' },
  sliderHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sliderLabel: { fontSize: 13, fontWeight: 500 },
  sliderValue: { fontSize: 14, fontWeight: 700, color: 'var(--accent)' },
  slider: { width: '100%', appearance: 'none', height: 4, borderRadius: 2, background: 'var(--border)', outline: 'none' },
  sliderHints: { display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-muted)' },
  toneItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-light)' },
  toneLabel: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 },
  toneValue: { fontSize: 13, color: 'var(--text-primary)', textAlign: 'right', maxWidth: '60%' },
  logoutBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: '1.5px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },

  // Notification styles
  notifRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  notifInfo: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  notifLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  notifDesc: { fontSize: 11, color: 'var(--text-muted)' },
  notifChannels: { display: 'flex', gap: 4 },
  notifChip: { width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  reminderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  reminderLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  channelPicker: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, marginTop: 4 },
  channelLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' },
  channelOptions: { display: 'flex', gap: 6 },
  channelChip: { padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Payments
  connectionStatus: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  connectionLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  connectBtn: { padding: '10px 20px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  paymentMethodRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  methodLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  methodDesc: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  depositRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  depositLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  depositHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  depositAmountRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  depositAmountLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' },
  depositOptions: { display: 'flex', gap: 6 },
  depositChip: { padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  depositFooter: { fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 },
  payoutRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  payoutLabel: { fontSize: 12, color: 'var(--text-muted)' },
  payoutValue: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },

  // Calendar sync
  calendarProviderRow: { display: 'flex', alignItems: 'center', gap: 12 },
  calProviderLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  calProviderStatus: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },
  syncRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  syncLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  syncHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  bufferOptions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  bufferChip: { padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};

/**
 * SubscriptionManager — Opens Stripe Customer Portal to manage subscription
 */
function SubscriptionManager({ beautician }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleManageSubscription() {
    setLoading(true);
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const response = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'Failed to open subscription portal');
      }
    } catch (err) {
      logger.error('Portal error:', err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Manage Subscription</div>
      <p style={styles.cardHint}>Update payment method, billing address, or cancel your subscription.</p>
      {error && <p style={{ ...styles.cardHint, color: '#E57373', marginTop: 8 }}>{error}</p>}
      <button
        onClick={handleManageSubscription}
        disabled={loading}
        style={{
          ...styles.connectBtn,
          opacity: loading ? 0.6 : 1,
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Opening...' : 'Open Stripe Portal'}
      </button>
    </div>
  );
}
