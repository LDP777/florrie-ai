import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ds, type } from '../lib/designSystem.js';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { monthlyMessageUsage, smsSettingsChanges, writeSmsSettings } from '../lib/sms-settings.js';
import PageHeader from '../components/ui/PageHeader.jsx';

const tabs = ['Overview', 'Message examples', 'Settings'];
const initialRead = { loading: true, error: null, data: null };
const inputStyle = { ...ds.input, width: '100%', minHeight: 44, boxSizing: 'border-box' };
const linkStyle = { ...ds.btnSecondary, display: 'inline-flex', alignItems: 'center', minHeight: 44, boxSizing: 'border-box', textDecoration: 'none' };
const templates = [
  { id: 'booking_confirmation', name: 'Booking confirmation', required: true, trigger: 'After booking', message: 'Hi {name}, your {treatment} is confirmed for {date} at {time}. {business}' },
  { id: 'reminder_24h', name: '24-hour reminder', required: true, trigger: 'Before the appointment', message: 'Reminder: {name}, your {treatment} is tomorrow at {time}. See you then! {business}' },
  { id: 'reminder_1h', name: '1-hour reminder', trigger: 'Before the appointment', message: '{name}, your appointment is in 1 hour at {time}. {business}' },
  { id: 'rebook_nudge', name: 'Rebooking reminder', trigger: 'When a client is due to rebook', message: 'Hey {name}! Ready to book in again? {booking_link}, {business}' },
];

function ReadIssue({ state, label, retry }) {
  if (state.loading) return <p role="status" style={type.bodySmall}>Loading {label}…</p>;
  if (!state.error) return null;
  return <div role="alert" style={{ marginBottom: 12 }}>
    <p style={type.bodySmall}>Couldn’t load {label}. {state.error}</p>
    <button style={ds.btnSecondary} onClick={retry}>Retry {label}</button>
  </div>;
}

export default function SMSConfig() {
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState(initialRead);
  const [usage, setUsage] = useState(initialRead);
  const [prefs, setPrefs] = useState(initialRead);
  const [form, setForm] = useState({ name: '', inbound: '', channel: '' });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState(null);
  const mounted = useRef(false);
  const reads = useRef({ config: 0, usage: 0, prefs: 0 });
  const savePending = useRef(false);
  const testPending = useRef(false);

  async function load(kind) {
    const revision = ++reads.current[kind];
    const setter = { config: setConfig, usage: setUsage, prefs: setPrefs }[kind];
    const current = () => mounted.current && revision === reads.current[kind];
    setter(previous => ({ ...previous, loading: true, error: null }));
    try {
      const path = { config: '/api/notifications/sms/config', usage: '/api/whatsapp/status', prefs: '/api/notifications/preferences' }[kind];
      const response = await readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}${path}` });
      let data = response;
      if (kind === 'usage') data = monthlyMessageUsage(response);
      if (kind === 'prefs') {
        data = response?.client_reminder_prefs;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Please try again.');
      }
      if (kind === 'config' && (!data || typeof data.bird_configured !== 'boolean' || typeof data.sms_originator !== 'string')) {
        throw new Error('Please try again.');
      }
      if (!current()) return;
      setter({ data, error: null, loading: false });
      if (kind === 'config') setForm({ name: data.sms_originator || 'Florrie', inbound: data.sms_inbound_number || '', channel: data.sms_channel_id || '' });
    } catch (error) {
      if (current()) setter(previous => ({ ...previous, loading: false, error: error.message }));
    }
  }

  useEffect(() => {
    mounted.current = true;
    load('config'); load('usage'); load('prefs');
    return () => { mounted.current = false; for (const key of Object.keys(reads.current)) reads.current[key]++; };
  }, []);

  const cfg = config.data;
  const changes = cfg ? smsSettingsChanges(cfg, form) : {};
  const dirty = Object.keys(changes).length > 0;
  const edit = (key, value) => { setForm(previous => ({ ...previous, [key]: value })); setSaveMsg(null); };

  async function saveConfig() {
    if (!cfg || cfg.schema_split !== true || !dirty || savePending.current) return;
    savePending.current = true;
    setSaving(true); setSaveMsg(null);
    try {
      if (changes.sms_originator && !/[a-zA-Z]/.test(changes.sms_originator)) {
        throw new Error('Include a letter in the business name so it cannot be mistaken for a sending number.');
      }
      const data = await writeSmsSettings({ auth: supabase.auth, url: `${API_BASE}/api/notifications/sms/config`, method: 'PUT', body: changes });
      if (!mounted.current) return;
      // The API confirms the write before its routing readback. Preserve fields
      // this form did not change, including the owner's reminder channel.
      const saved = { ...cfg, ...changes };
      saved.two_way = !!saved.sms_inbound_number;
      setConfig(previous => ({ ...previous, data: saved }));
      setForm({ name: saved.sms_originator, inbound: saved.sms_inbound_number || '', channel: saved.sms_channel_id || '' });
      setSaveMsg({ ok: true, text: data.warnings?.[0] ? `Saved. ${data.warnings[0]}` : 'SMS settings saved.' });
    } catch (error) {
      if (mounted.current) setSaveMsg({ ok: false, text: error.message });
    } finally { savePending.current = false; if (mounted.current) setSaving(false); }
  }

  async function sendTest() {
    if (!testPhone.trim() || testPending.current || dirty) return;
    testPending.current = true;
    setTesting(true); setTestMsg(null);
    const phone = testPhone.trim();
    try {
      await writeSmsSettings({ auth: supabase.auth, url: `${API_BASE}/api/notifications/sms/test`, method: 'POST', body: { phone } });
      if (mounted.current) {
        setTestMsg({ ok: true, text: `Test accepted for sending to ${phone}. Check the phone to confirm it arrived.` });
        load('usage');
      }
    } catch (error) {
      if (mounted.current) setTestMsg({ ok: false, text: error.message });
    } finally { testPending.current = false; if (mounted.current) setTesting(false); }
  }

  const replyReady = !!cfg?.two_way && !!cfg?.sms_channel_id;
  const selectedChannel = prefs.data?.channel || (prefs.data ? 'whatsapp' : null);
  const channelName = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' }[selectedChannel];
  const preferenceLink = <Link to="/settings?section=notifications" style={linkStyle}>Reminder preferences</Link>;

  return <div style={ds.page}>
    <PageHeader title="SMS" subtitle="Text messages, reminders and replies" />
    <div style={{ ...ds.card, marginBottom: 16 }}>
      <ReadIssue state={config} label="SMS setup" retry={() => load('config')} />
      {cfg && <>
        <h2 style={type.heading}>{cfg.bird_configured ? 'Check SMS sending with a test' : 'SMS setup needs attention'}</h2>
        <p style={type.bodySmall}>{cfg.bird_configured
          ? 'Send a test from Settings to check that messages reach your phone.'
          : 'Contact Florrie support to finish setting up SMS.'}</p>
        <p style={type.bodySmall}>{cfg.schema_split !== true ? 'Your reply setup needs checking before sending details can be changed.' : replyReady
          ? `Your reply number is ${cfg.sms_inbound_number}.`
          : 'Replies to the shared Florrie number do not reach your inbox.'}</p>
        {cfg.two_way && !cfg.sms_channel_id && <p style={{ ...type.bodySmall, color: 'var(--warning)' }}>
          Your reply number is saved, but outgoing texts still use the shared number. Finish the dedicated number setup before inviting clients to reply.
        </p>}
      </>}
    </div>

    <section aria-label="Plan message usage" style={{ ...ds.card, marginBottom: 16 }}>
      <h2 style={type.heading}>This month’s messages</h2>
      <ReadIssue state={usage} label="message usage" retry={() => load('usage')} />
      {usage.data && !usage.error && <>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '12px 0' }}>
          {[
            ['Counted this month', `${usage.data.total_sent} / ${usage.data.free_limit}`],
            ['Included remaining', usage.data.remaining],
            ['Extra message charges', `£${(usage.data.overage_total_pence / 100).toFixed(2)}`],
          ].map(([label, value]) => <div key={label} style={{ flex: '1 1 90px' }}>
            <div style={{ ...type.heading, fontSize: 20 }}>{value}</div><div style={type.bodySmall}>{label}</div>
          </div>)}
        </div>
        <p style={type.bodySmall}>{usage.data.sms_sent} SMS · {usage.data.whatsapp_sent} WhatsApp · {new Date(usage.data.month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p>
      </>}
      <p style={type.bodySmall}>SMS and chargeable WhatsApp messages share your monthly allowance. Beyond it, SMS costs 6p and WhatsApp costs 5p per message.</p>
      <Link to="/settings?section=payments" style={{ ...linkStyle, marginTop: 8 }}>Plan and billing</Link>
    </section>

    <div style={ds.tabBar} role="tablist" aria-label="SMS sections">
      {tabs.map((name, index) => <button key={name} role="tab" aria-selected={tab === index} onClick={() => setTab(index)} style={{ ...ds.tab, minHeight: 44, ...(tab === index ? ds.tabActive : {}) }}>{name}</button>)}
    </div>

    {tab === 0 && <div style={ds.card}>
      <h2 style={type.heading}>Choose how clients hear from you</h2>
      <ReadIssue state={prefs} label="reminder preferences" retry={() => load('prefs')} />
      {!prefs.error && channelName && <p style={type.body}>Your preferred reminder channel is {channelName}.</p>}
      <p style={type.bodySmall}>Manage your reminder channel and optional follow-ups in one place. Saving SMS setup here does not change those choices.</p>
      {preferenceLink}
      <h3 style={{ ...type.heading, marginTop: 24 }}>Receiving replies</h3>
      <p style={type.bodySmall}>{replyReady
        ? 'A dedicated sending channel and reply number are saved. Incoming texts use your usual Florrie reply controls.'
        : 'The shared sending number is one-way. If you already have a dedicated Bird number, its setup is under Settings. Ask Florrie support before changing it.'}</p>
    </div>}

    {tab === 1 && <div>
      <div style={{ ...ds.card, marginBottom: 12 }}>
        <p style={type.bodySmall}>These are message examples, not a record of sent texts. Wording varies with the booking. Your preferences decide which channel is used.</p>
        <ReadIssue state={prefs} label="reminder preferences" retry={() => load('prefs')} />
        {preferenceLink}
      </div>
      {templates.map(template => {
        const status = !prefs.data || prefs.error ? 'Status unavailable' : template.required ? 'Core reminder'
          : (template.id === 'reminder_1h' ? prefs.data.reminder_1h === true : prefs.data.rebook_nudge !== false) ? 'On' : 'Off';
        return <section key={template.id} aria-label={template.name} style={{ ...ds.card, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
            <h2 style={type.heading}>{template.name}</h2><span style={ds.badge}>{status}</span>
          </div>
          <p style={type.bodySmall}>{template.trigger}</p>
          <p style={{ ...type.body, background: 'var(--bg-subtle)', borderRadius: 10, padding: 12 }}>{template.message.replace('{business}', cfg?.sms_originator || '{business}')}</p>
        </section>;
      })}
    </div>}

    {tab === 2 && <div>
      {!cfg ? <div style={ds.card}><ReadIssue state={config} label="SMS setup" retry={() => load('config')} /></div> : <>
        <div style={{ ...ds.card, marginBottom: 12 }}>
          <h2 style={type.heading}>Sending details</h2>
          <p style={type.bodySmall}>To change the channel used for reminders, open your reminder preferences.</p>
          {preferenceLink}
          {cfg.schema_split !== true && <p role="status" style={type.bodySmall}>Sending details are read-only until Florrie support checks this older SMS setup. Your saved setup has not changed.</p>}
          <fieldset disabled={saving || testing || cfg.schema_split !== true} style={{ border: 0, padding: 0, margin: '20px 0 12px', minWidth: 0 }}>
            <label htmlFor="sms-name" style={ds.inputLabel}>Business name in messages</label>
            <p style={type.bodySmall}>Up to 11 letters and numbers. This signs off your messages; it does not change your sending number.</p>
            <input id="sms-name" style={inputStyle} value={form.name} onChange={event => edit('name', event.target.value.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 11))} />
            <details style={{ marginTop: 20 }}>
              <summary style={{ cursor: 'pointer', minHeight: 44, ...type.body }}>Advanced: dedicated number setup</summary>
              <p style={type.bodySmall}>Only change these if you already have a dedicated Bird number. Leave both empty to keep the shared sending number. Changing routing can affect client replies.</p>
              <label htmlFor="sms-inbound" style={ds.inputLabel}>Dedicated reply number</label>
              <input id="sms-inbound" style={inputStyle} inputMode="tel" placeholder="+447700900123" value={form.inbound} onChange={event => edit('inbound', event.target.value.replace(/[^0-9+ ]/g, '').slice(0, 20))} />
              <label htmlFor="sms-channel" style={{ ...ds.inputLabel, marginTop: 16 }}>Bird channel ID</label>
              <input id="sms-channel" style={inputStyle} value={form.channel} onChange={event => edit('channel', event.target.value.trim().slice(0, 36))} />
            </details>
          </fieldset>
          <button onClick={saveConfig} disabled={saving || testing || !dirty || cfg.schema_split !== true} style={ds.btnPrimary}>{saving ? 'Saving…' : 'Save SMS settings'}</button>
          {dirty && <p style={type.bodySmall}>You have unsaved changes.</p>}
          {saveMsg && <p role={saveMsg.ok ? 'status' : 'alert'} style={{ ...type.bodySmall, color: saveMsg.ok ? 'var(--success)' : 'var(--danger)' }}>{saveMsg.text}</p>}
        </div>
        {cfg.bird_configured && <div style={ds.card}>
          <h2 style={type.heading}>Check a test message</h2>
          <p style={type.bodySmall}>Send one text to your own phone using the saved setup. It counts towards your message usage.</p>
          {dirty && <p style={type.bodySmall}>Save your changes before sending a test.</p>}
          <label htmlFor="sms-test" style={ds.inputLabel}>Your phone number</label>
          <input id="sms-test" inputMode="tel" style={inputStyle} placeholder="+447700900000" value={testPhone} disabled={testing} onChange={event => setTestPhone(event.target.value)} />
          <button onClick={sendTest} disabled={testing || saving || dirty || !testPhone.trim()} style={{ ...ds.btnPrimary, marginTop: 12 }}>{testing ? 'Sending…' : 'Send test SMS'}</button>
          {testMsg && <p role={testMsg.ok ? 'status' : 'alert'} style={{ ...type.bodySmall, color: testMsg.ok ? 'var(--success)' : 'var(--danger)' }}>{testMsg.text}</p>}
        </div>}
      </>}
    </div>}
  </div>;
}
