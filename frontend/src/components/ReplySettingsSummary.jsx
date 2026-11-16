import { replyControlSummary } from '../lib/reply-control-summary.js';

export default function ReplySettingsSummary({ owner }) {
  const summary = replyControlSummary(owner);
  return <section className="reply-settings-summary" aria-labelledby="reply-summary-title">
    <style>{`.reply-settings-summary{padding:22px;border:1px solid var(--border);border-radius:20px;background:var(--bg-card);margin-bottom:20px}.reply-settings-summary h3{margin:0 0 8px;font-size:18px}.reply-settings-summary p{font-size:13px;line-height:1.6;color:var(--text-secondary)}.reply-settings-summary dl{margin:18px 0}.reply-settings-summary dl>div{display:flex;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--border-light)}.reply-settings-summary dt{font-size:13px}.reply-settings-summary dd{margin:0;text-align:right;font-size:13px;font-weight:600;color:var(--accent)}.reply-settings-summary .reply-summary-pause{padding:12px;border-radius:12px;background:var(--tone-1);font-weight:600}`}</style>
    <h3 id="reply-summary-title">Your reply settings, at a glance</h3>
    {summary.paused && <p className="reply-summary-pause">Messaging is paused. The choices below are saved for when you resume.</p>}
    <dl>{summary.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p>{summary.overrides} Individual message types below keep their own choices when you change the default.</p>
    <p>These settings apply to connected channels. Each client’s Me or Drafts first choice and Florrie’s safety checks still apply. Booking confirmations and reminders have separate delivery settings.</p>
  </section>;
}
