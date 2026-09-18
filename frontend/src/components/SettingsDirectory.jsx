import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon, { iconName } from './ui/Icon';
import Button from './ui/Button.jsx';

export const SETTINGS_SECTIONS = [
  { key: 'profile', title: 'Business details', group: 'Your salon', icon: 'person', description: 'Your name, contact details, booking link and tax information.', keywords: 'address phone email slug timezone VAT' },
  { key: 'hours', title: 'Opening hours', group: 'Your salon', icon: 'schedule', description: 'Your usual working week and time away.', keywords: 'holidays time off availability' },
  { key: 'policy', title: 'Booking rules', group: 'Your salon', icon: 'event_note', description: 'Notice periods, cancellations and how clients book.', keywords: 'policy patch test buffer booking window deposits' },
  { key: 'payments', title: 'Payments', group: 'Your salon', icon: 'payments', description: 'Stripe, deposits, payment methods and bank details.', keywords: 'fees cash transfer balance card' },
  { key: 'connections', title: 'Connected apps', group: 'Messages & Florrie', icon: 'link', description: 'Connect or check Instagram, WhatsApp and SMS.', keywords: 'channels messaging meta social reconnect' },
  { key: 'ai', title: 'Florrie & replies', group: 'Messages & Florrie', icon: 'auto_awesome', description: 'Her voice, replies and what she can send for you.', keywords: 'ai autopilot autonomy tone confidence instagram dm automatic ask approval' },
  { key: 'notifications', title: 'Notifications & reminders', group: 'Messages & Florrie', icon: 'notifications', description: 'Your alerts, quiet hours and client reminders.', keywords: 'push email sms whatsapp aftercare follow up' },
  { key: 'calendar', title: 'Calendar sync', group: 'Your preferences', icon: 'calendar_month', description: 'Connect Google Calendar and choose what syncs.', keywords: 'personal buffer appointments' },
  { key: 'account', title: 'Account & appearance', group: 'Your preferences', icon: 'person', description: 'Appearance, voice button, account access and sign out.', keywords: 'theme dark light password delete logout celebrations' },
];

export function settingsSection(value) {
  return SETTINGS_SECTIONS.some(section => section.key === value) ? value : '';
}

export default function SettingsDirectory({ section, onSelect }) {
  const [query, setQuery] = useState('');
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = SETTINGS_SECTIONS.filter(item => terms.every(term => `${item.title} ${item.description} ${item.keywords}`.toLowerCase().includes(term)));
  const groups = [...new Set(matches.map(item => item.group))];

  return <>
    <style>{styles}</style>
    {section ? <nav className="settings-current-nav" aria-label="Settings sections">
      <Button variant="quiet" onClick={() => onSelect('')}><Icon name={iconName('arrow_back')} size={17} /> All settings</Button>
      <label className="settings-section-picker">
        <span className="sr-only">Settings section</span>
        <select aria-label="Settings section" value={section} onChange={event => onSelect(event.target.value)}>
          {SETTINGS_SECTIONS.map(item => <option key={item.key} value={item.key}>{item.title}</option>)}
        </select>
      </label>
    </nav> : <div className="settings-directory">
      <div className="settings-directory-search" role="search">
        <Icon name={iconName('search')} size={20} />
        <input type="search" aria-label="Search settings" placeholder="Find Instagram, deposits, reminders…" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <Button variant="quiet" size="sm" onClick={() => setQuery('')}>Clear</Button>}
      </div>
      {query && <p role="status" className="settings-search-count">{matches.length} {matches.length === 1 ? 'section' : 'sections'} found</p>}
      {groups.map(group => <section key={group} className="settings-directory-group" aria-label={group}>
        <h2>{group}</h2>
        <div className="settings-directory-grid">
          {matches.filter(item => item.group === group).map(item => <Link key={item.key} to={`/settings?section=${item.key}`} className="settings-directory-link">
            <span className="settings-directory-icon" aria-hidden="true"><Icon name={iconName(item.icon)} size={21} /></span>
            <span className="settings-directory-copy"><strong>{item.title}</strong><span>{item.description}</span></span>
            <Icon name={iconName('chevron_right')} size={18} />
          </Link>)}
        </div>
      </section>)}
      {matches.length === 0 && <p className="settings-no-results">No settings found. Try “Instagram”, “hours” or “payments”.</p>}
      {!query && <aside className="settings-help-links">
        <Link to="/setup"><Icon name={iconName('checklist')} size={20} /><span><strong>Setting up your salon?</strong><span>Follow the setup guide</span></span><Icon name={iconName('arrow_forward')} size={18} /></Link>
        <Link to="/knowledge"><Icon name={iconName('menu_book')} size={20} /><span><strong>Teach Florrie your answers</strong><span>Add guidance and practise questions</span></span><Icon name={iconName('arrow_forward')} size={18} /></Link>
      </aside>}
    </div>}
  </>;
}

const styles = `
.settings-directory-search{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;color:var(--text-secondary);margin-bottom:24px}
.settings-directory-search input{min-width:0;flex:1;min-height:50px;border:0;outline:0;background:transparent;font:inherit;font-size:14px;color:var(--text-primary)}
.settings-directory-search:focus-within{outline:2px solid var(--accent);outline-offset:3px}
.settings-directory-group{margin-bottom:24px}
.settings-directory-group h2{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--text-secondary)}
.settings-directory-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.settings-directory-link{display:flex;align-items:center;gap:12px;padding:17px 15px;min-height:98px;box-sizing:border-box;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);color:var(--text-primary);text-decoration:none}
.settings-directory-link:hover{border-color:var(--accent);background:var(--bg-hover)}
.settings-directory-link:focus-visible,.settings-help-links a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.settings-directory-icon{display:grid;place-items:center;width:42px;height:42px;flex-shrink:0;border-radius:14px;background:var(--bg-hover);color:var(--accent)}
.settings-directory-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:5px}
.settings-directory-copy strong{font-size:15px;font-weight:650;line-height:1.35}
.settings-directory-copy>span{font-size:13px;line-height:1.5;color:var(--text-secondary)}
.settings-search-count,.settings-no-results{font-size:14px;color:var(--text-secondary)}
.settings-help-links{border-top:1px solid var(--border);padding-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.settings-help-links a{display:flex;align-items:center;gap:12px;padding:13px 4px;min-height:44px;text-decoration:none;color:var(--accent)}
.settings-help-links a>span{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.settings-help-links strong{font-size:13px;font-weight:600}
.settings-help-links span span{font-size:12px;color:var(--text-secondary)}
.settings-current-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:20px}
.settings-current-nav button{padding-left:0;white-space:nowrap}
.settings-section-picker{min-width:0;max-width:65%}
.settings-section-picker select{min-height:44px;max-width:100%;padding:8px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);color:var(--text-primary);font:inherit;font-size:13px}
.settings-section-intro{margin:0 0 20px}
.settings-section-intro h2{font-family:'Playfair Display',Georgia,serif;font-size:23px;font-weight:600;margin:0 0 6px;color:var(--text-primary)}
.settings-section-intro p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.5}
.settings-field-editor{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:65%;flex:1}
.settings-field-editor input{width:100%;box-sizing:border-box}
.settings-field-actions{display:flex;justify-content:flex-end;gap:6px}
@media(max-width:560px){.settings-directory-grid,.settings-help-links{grid-template-columns:1fr}.settings-directory-link{min-height:94px}.settings-current-nav{align-items:flex-start}.settings-section-picker{max-width:61%}}
@media(prefers-reduced-motion:reduce){.settings-directory-link{transition:none}}
`;
