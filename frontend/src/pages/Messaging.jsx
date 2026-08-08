import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import WhatsAppConfig from './WhatsAppConfig.jsx';
import SMSConfig from './SMSConfig.jsx';
import Icon from '../components/ui/Icon';

/**
 * Messaging, single entry point for WhatsApp + SMS setup.
 *
 * Tabs between the two configs. Landing tab picks the sensible default:
 * - If WhatsApp is already connected, open WhatsApp tab so they land on "their" channel
 * - If SMS is already on (but WhatsApp isn't), open SMS tab
 * - Otherwise open the Overview tab which pitches both and lets the user pick
 *
 * Deep-link support: /messaging?tab=whatsapp | sms | overview
 */
export default function Messaging() {
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();

  const waConnected = !!beautician?.whatsapp_connected;
  const smsOn = !!beautician?.sms_enabled;

  const initial = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get('tab');
    if (t === 'whatsapp' || t === 'sms' || t === 'overview') return t;
    if (waConnected) return 'whatsapp';
    if (smsOn) return 'sms';
    return 'overview';
  }, [location.search, waConnected, smsOn]);

  const [tab, setTab] = useState(initial);

  function switchTab(next) {
    setTab(next);
    // Update URL without a reload so refresh keeps the tab
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState({}, '', url.toString());
  }

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={ds.pageTitle}>Messaging</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>
          WhatsApp + SMS in one place. Pick a channel to set it up or check its status.
        </p>
      </div>

      {/* Tabs */}
      <div style={styles.tabBar}>
        <TabButton active={tab === 'overview'} onClick={() => switchTab('overview')}>
          Overview
        </TabButton>
        <TabButton active={tab === 'whatsapp'} onClick={() => switchTab('whatsapp')}>
          WhatsApp
          <StatusDot on={waConnected} />
        </TabButton>
        <TabButton active={tab === 'sms'} onClick={() => switchTab('sms')}>
          SMS
          <StatusDot on={smsOn} />
        </TabButton>
      </div>

      {tab === 'overview' && (
        <Overview
          waConnected={waConnected}
          smsOn={smsOn}
          beautician={beautician}
          onPickWA={() => switchTab('whatsapp')}
          onPickSMS={() => switchTab('sms')}
        />
      )}
      {tab === 'whatsapp' && (
        <div style={{ marginTop: 12 }}>
          <WhatsAppConfig />
        </div>
      )}
      {tab === 'sms' && (
        <div style={{ marginTop: 12 }}>
          <SMSConfig />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...styles.tab,
        ...(active ? styles.tabActive : {}),
      }}
    >
      {children}
    </button>
  );
}

function StatusDot({ on }) {
  return (
    <span
      aria-hidden
      style={{ ...styles.statusDot,
        background: on ? 'var(--success, #3F7D5C)' : 'var(--border)',
      }}
    />
  );
}

function Overview({ waConnected, smsOn, beautician, onPickWA, onPickSMS }) {
  return (
    <div style={styles.overviewWrap}>
      {/* WhatsApp card */}
      <div style={{ ...styles.channelCard, ...styles.waCard }}>
        <div style={styles.channelHead}>
          <span style={styles.channelEmoji} aria-hidden><Icon name="message" size={15} /></span>
          <div style={styles.channelHeadCopy}>
            <div style={styles.channelTitle}>WhatsApp</div>
            <div style={styles.channelSub}>Recommended. Clients already use it.</div>
          </div>
          <span style={{ ...styles.statusChip,
            ...(waConnected ? styles.statusChipOn : styles.statusChipOff),
          }}>
            {waConnected ? 'Connected' : 'Off'}
          </span>
        </div>
        <ul style={styles.bullets}>
          <li>AI drafts replies in your voice, 24/7</li>
          <li>Books, reschedules, answers questions</li>
          <li>One-time Meta setup, about 15 minutes</li>
        </ul>
        <div style={styles.channelMeta}>
          {waConnected
            ? <span>Connected number: <b>{beautician?.whatsapp_phone || '-'}</b></span>
            : <span>Needs a spare UK mobile number and a few minutes with Meta.</span>}
        </div>
        <button
          type="button"
          onClick={onPickWA}
          style={styles.waBtn}
        >
          {waConnected ? 'Manage WhatsApp' : 'Connect WhatsApp'}
        </button>
      </div>

      {/* SMS card */}
      <div style={{ ...styles.channelCard, ...styles.smsCard }}>
        <div style={styles.channelHead}>
          <span style={styles.channelEmoji} aria-hidden><Icon name="phone" size={15} /></span>
          <div style={styles.channelHeadCopy}>
            <div style={styles.channelTitle}>SMS</div>
            <div style={styles.channelSub}>Works with any mobile. Two-way from our UK number.</div>
          </div>
          <span style={{ ...styles.statusChip,
            ...(smsOn ? styles.statusChipOn : styles.statusChipOff),
          }}>
            {smsOn ? 'On' : 'Off'}
          </span>
        </div>
        <ul style={styles.bullets}>
          <li>Reminders and confirmations go out automatically</li>
          <li>Clients can reply by text. Everything lands in Florrie.</li>
          <li>No Meta sign-up needed. Live in under a minute.</li>
        </ul>
        <div style={styles.channelMeta}>
          {smsOn
            ? <span>Sending from <b>{beautician?.sms_originator || 'Florrie'}</b></span>
            : <span>Pre-filled with our shared UK longcode. You can bring your own later.</span>}
        </div>
        <button
          type="button"
          onClick={onPickSMS}
          style={styles.smsBtn}
        >
          {smsOn ? 'Manage SMS' : 'Turn on SMS'}
        </button>
      </div>

      <div style={styles.helperRow}>
        Running both is fine. WhatsApp for regulars, SMS for the rest.
      </div>
    </div>
  );
}

const styles = {
  tabBar: {
    display: 'flex',
    gap: 6,
    padding: 4,
    background: 'var(--bg-hover)',
    borderRadius: 10,
    marginBottom: 4,
  },
  tab: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '9px 10px',
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tabActive: {
    background: 'var(--bg-card, #FFFCF9)',
    color: 'var(--text-primary)',
    boxShadow: 'var(--elev-1)',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  overviewWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    marginTop: 14,
  },
  channelCard: {
    borderRadius: 16,
    padding: 16,
    border: '1px solid var(--border)',
    background: 'var(--bg-card, #FFFCF9)',
  },
  waCard: {
    background: 'linear-gradient(180deg, rgba(37, 211, 102, 0.06) 0%, var(--bg-card, #FFFCF9) 60%)',
    borderColor: 'rgba(37, 211, 102, 0.25)',
  },
  smsCard: {
    background: 'linear-gradient(180deg, rgba(199, 107, 138, 0.05) 0%, var(--bg-card, #FFFCF9) 60%)',
    borderColor: 'rgba(199, 107, 138, 0.20)',
  },
  channelHead: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  channelEmoji: {
    fontSize: 20,
    lineHeight: 1,
    flexShrink: 0,
    marginTop: 1,
  },
  channelHeadCopy: {
    flex: 1,
    minWidth: 0,
  },
  channelTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 2,
  },
  channelSub: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.45,
  },
  statusChip: {
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 9px',
    borderRadius: 999,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    flexShrink: 0,
    alignSelf: 'flex-start',
  },
  statusChipOn: {
    color: 'var(--success, #3F7D5C)',
    background: 'rgba(22, 101, 52, 0.10)',
  },
  statusChipOff: {
    color: 'var(--text-muted)',
    background: 'var(--bg-hover)',
  },
  bullets: {
    margin: '6px 0 10px',
    paddingLeft: 18,
    fontSize: 12.5,
    color: 'var(--text-secondary)',
    lineHeight: 1.65,
  },
  channelMeta: {
    fontSize: 11.5,
    color: 'var(--text-muted)',
    marginBottom: 12,
    lineHeight: 1.45,
  },
  waBtn: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: 'none',
    // WhatsApp brand green, the darker of the two official ones. #25D366 is
    // the familiar bright green and white on it measures 1.98:1 — their own
    // marketing pairs it with dark text, not white. #128C7E is equally theirs
    // one step darker at #0F7A6C, which measures 5.0:1. Measured, not estimated:
    // #128C7E came out at 4.14:1, which is short of AA for 13px text.
    background: '#0F7A6C',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  smsBtn: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  helperRow: {
    textAlign: 'center',
    fontSize: 12,
    color: 'var(--text-muted)',
    padding: '6px 0 4px',
  },
};
