import { useEffect, useRef, useState } from 'react';
import Button from './ui/Button.jsx';
import { cancellationNoticeHours, policyFeePercent } from '../lib/booking-policy.js';

const WINDOWS = [0, 30, 60, 90];
const numericFields = {
  min_booking_hours: [0, 72], max_advance_days: [0, 3650], payment_buffer_minutes: [5, 60],
  cancellation_notice_hours: [0, 168], late_cancel_charge_percent: [0, 100], no_show_charge_percent: [0, 100],
};
const numbers = policy => ({
  min_booking_hours: policy.min_booking_hours ?? 0,
  max_advance_days: policy.max_advance_days ?? 0,
  payment_buffer_minutes: policy.payment_buffer_minutes ?? 10,
  cancellation_notice_hours: cancellationNoticeHours(policy),
  late_cancel_charge_percent: policyFeePercent(policy),
  no_show_charge_percent: policyFeePercent(policy, 'no_show'),
});
const valuesFor = policy => ({ ...numbers(policy),
  payment_buffer_enabled: policy.payment_buffer_enabled === true,
  require_deposit_on_late_reschedule: policy.require_deposit_on_late_reschedule === true,
  reschedule_once: policy.reschedule_once === true,
  reschedule_between_only: policy.reschedule_between_only === true,
  cancellation_message: policy.cancellation_message || '',
});
const same = (key, a, b) => key in numericFields ? String(a) === String(b) : a === b;
const duration = hours => Number(hours) % 24 === 0 && Number(hours) > 0
  ? `${Number(hours) / 24} ${Number(hours) === 24 ? 'day' : 'days'}` : `${hours} ${Number(hours) === 1 ? 'hour' : 'hours'}`;

function focusField(id) {
  const field = document.getElementById(id);
  field?.scrollIntoView({ block: 'center', behavior: 'auto' });
  field?.focus({ preventScroll: true });
}

function NumberField({ id, label, value, unit, min, max, hint, onChange }) {
  return <div className="booking-policy-field">
    <div className="booking-policy-field-top">
      <label htmlFor={id}>{label}</label>
      <div className="booking-policy-number"><input id={id} type="number" inputMode="numeric" min={min} max={max} step="1"
        value={value} aria-describedby={`${id}-help`} onChange={event => onChange(event.target.value)} /><span aria-hidden="true">{unit}</span></div>
    </div>
    <p id={`${id}-help`}>{hint}</p>
  </div>;
}

function ToggleField({ id, label, checked, hint, onChange }) {
  return <div className="booking-policy-field">
    <div className="booking-policy-field-top"><label htmlFor={id}>{label}</label>
      <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={`${id}-help`}
        aria-label={label} className="booking-policy-toggle" onClick={() => onChange(!checked)}>{checked ? 'On' : 'Off'}<span aria-hidden="true" /></button>
    </div><p id={`${id}-help`}>{hint}</p>
  </div>;
}

function PreviewLine({ children, field, label }) {
  return <div className="booking-policy-preview-row"><p>{children}</p><Button variant="quiet" size="sm"
    aria-label={`Edit ${label}`} onClick={() => focusField(field)}>Edit</Button></div>;
}

/** Owner identity remounts the draft, including any in-flight save response. */
export default function BookingPolicyEditor(props) {
  return <PolicyDraft key={props.beautician?.id || 'no-owner'} {...props} />;
}

function PolicyDraft({ beautician, onSave, saveError }) {
  const sourcePolicy = beautician?.booking_policy || {};
  const sourceKey = JSON.stringify(sourcePolicy);
  const [acknowledged, setAcknowledged] = useState(null);
  const policy = acknowledged?.sourceKey === sourceKey ? acknowledged.policy : sourcePolicy;
  const [changes, setChanges] = useState({});
  const [customWindow, setCustomWindow] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const live = useRef(true), saving = useRef(false), latestPolicy = useRef(policy), latestSourceKey = useRef(sourceKey);
  latestPolicy.current = policy; latestSourceKey.current = sourceKey;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const baseline = valuesFor(policy);
  const value = { ...baseline, ...changes };
  const dirty = Object.entries(changes).some(([key, changed]) => !same(key, changed, baseline[key]));
  const valid = Object.entries(numericFields).every(([key, [min, max]]) =>
    String(value[key]).trim() !== '' && Number.isInteger(Number(value[key])) && Number(value[key]) >= min && Number(value[key]) <= max);
  const set = (key, next) => {
    if (saving.current) return;
    setChanges(previous => ({ ...previous, [key]: next })); setError(''); setStatus('');
  };
  const reset = () => { if (!saving.current) { setChanges({}); setCustomWindow(false); setError(''); setStatus('Changes reset.'); } };
  async function save(event) {
    event.preventDefault();
    if (!dirty || !valid || saving.current || !beautician?.id) return;
    saving.current = true; setPending(true); setError(''); setStatus('');
    // Keep unknown policy keys and a refresh's untouched settings. Explicitly
    // retain the displayed no-show percentage even if its old default inherited
    // the late-cancellation percentage that the owner has just changed.
    const submitted = { ...latestPolicy.current, ...valuesFor(latestPolicy.current), ...changes };
    for (const key of Object.keys(numericFields)) submitted[key] = Number(submitted[key]);
    submitted.cancellation_message = submitted.cancellation_message.trim();
    try {
      const saved = await onSave(submitted);
      if (!live.current) return;
      if (saved === true) {
        setAcknowledged({ sourceKey: latestSourceKey.current, policy: submitted });
        setChanges({}); setStatus('Policy saved.');
      }
      else setError('Could not save your policy. Your edits are still here.');
    } catch {
      if (live.current) setError('Could not save your policy. Your edits are still here.');
    } finally {
      if (live.current) { saving.current = false; setPending(false); }
    }
  }

  const minHours = Number(value.min_booking_hours), cancelHours = Number(value.cancellation_notice_hours);
  const lateFee = Number(value.late_cancel_charge_percent), noShowFee = Number(value.no_show_charge_percent);
  const maxDays = Number(value.max_advance_days);
  const showCustom = customWindow || !WINDOWS.includes(maxDays);
  return <form className="booking-policy-editor" onSubmit={save}>
    <style>{css}</style>
    <div className="booking-policy-intro"><p>Make these rules yours.</p><span>Change the settings or your wording, check the summary, then save your policy.</span></div>
    <div className="booking-policy-savebar">
      <div role="status" aria-live="polite">{pending ? 'Saving your policy…' : status || (dirty ? 'You have unsaved changes' : 'All changes are saved')}</div>
      {error && <p className="booking-policy-error" role="alert">{saveError || error}</p>}
      {!valid && dirty && <p className="booking-policy-error" role="alert">Check the numbers above. Use whole numbers within the ranges shown.</p>}
      <div className="booking-policy-save-actions"><Button variant="quiet" disabled={!dirty || pending} onClick={reset}>Reset edits</Button>
        <Button type="submit" loading={pending} disabled={!dirty || !valid || pending}>Save policy</Button></div>
    </div>
    <fieldset disabled={pending} className="booking-policy-fields">
      <section className="booking-policy-card" aria-labelledby="policy-booking-heading">
        <h3 id="policy-booking-heading">Taking bookings</h3>
        <NumberField id="minimum-booking-notice" label="Minimum booking notice" value={value.min_booking_hours} unit="hours" min={0} max={72}
          hint="0 allows bookings without advance notice, subject to availability and preparation requirements." onChange={next => set('min_booking_hours', next)} />
        <div className="booking-policy-field"><label htmlFor="booking-window">How far ahead clients can book</label>
          <select id="booking-window" value={showCustom ? 'custom' : String(maxDays)} onChange={event => {
            const next = event.target.value; setCustomWindow(next === 'custom'); if (next !== 'custom') set('max_advance_days', Number(next));
          }}><option value="0">No advance limit</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="custom">Custom number of days</option></select>
          <p>Choose when clients can book through your booking page.</p>
          {showCustom && <NumberField id="custom-booking-window" label="Custom booking window" value={value.max_advance_days} unit="days" min={0} max={3650}
            hint="Enter a whole number of days. 0 means no advance limit." onChange={next => set('max_advance_days', next)} />}
        </div>
      </section>

      <section className="booking-policy-card" aria-labelledby="policy-cancellation-heading">
        <h3 id="policy-cancellation-heading">Cancellations &amp; no-shows</h3>
        <NumberField id="cancellation-notice" label="Cancellation notice" value={value.cancellation_notice_hours} unit="hours" min={0} max={168}
          hint="How much notice you need to cancel or move a booking. 0 means no advance cancellation notice." onChange={next => set('cancellation_notice_hours', next)} />
        <NumberField id="late-cancellation-fee" label="Late-cancellation fee" value={value.late_cancel_charge_percent} unit="%" min={0} max={100}
          hint={cancelHours === 0 ? 'No late-cancellation fee applies with 0 hours’ notice. The percentage is kept if you add a notice period later.' : 'Percentage of the appointment price. A paid deposit counts towards it; a saved card can be charged when the client cancels.'}
          onChange={next => set('late_cancel_charge_percent', next)} />
        <NumberField id="no-show-fee" label="No-show charge" value={value.no_show_charge_percent} unit="%" min={0} max={100}
          hint="Separate from cancellation notice. A paid deposit counts towards the fee; a saved card can be charged when you mark a no-show."
          onChange={next => set('no_show_charge_percent', next)} />
        <p className="booking-policy-callout">100% means the full appointment price. 0% means no additional fee is configured. Your written note does not change these amounts.</p>
      </section>

      <section className="booking-policy-card" aria-labelledby="policy-reschedule-heading">
        <h3 id="policy-reschedule-heading">Moving appointments</h3>
        <ToggleField id="late-reschedule-deposit" label="New deposit on a late reschedule" checked={value.require_deposit_on_late_reschedule}
          hint={cancelHours === 0 ? 'This does not apply with 0 hours’ cancellation notice.' : 'Inside your notice window, the original late-cancellation fee and a fresh deposit may be charged to the saved card. Without a usable card, the move cannot go ahead.'}
          onChange={next => set('require_deposit_on_late_reschedule', next)} />
        <ToggleField id="reschedule-once" label="Allow only one reschedule" checked={value.reschedule_once}
          hint="After moving a booking once, the client needs to contact you to move it again." onChange={next => set('reschedule_once', next)} />
        <ToggleField id="reschedule-between" label="Keep reschedules beside existing bookings" checked={value.reschedule_between_only}
          hint="Only offer times directly before or after another appointment that day." onChange={next => set('reschedule_between_only', next)} />
      </section>

      <section className="booking-policy-card" aria-labelledby="policy-payment-heading">
        <h3 id="policy-payment-heading">Time to pay</h3>
        <ToggleField id="payment-hold" label="Set a payment hold window" checked={value.payment_buffer_enabled}
          hint="Choose how long an unpaid booking is held before it can be released. Payment-provider limits can affect the payment link’s expiry." onChange={next => set('payment_buffer_enabled', next)} />
        {value.payment_buffer_enabled && <NumberField id="payment-hold-minutes" label="Payment hold time" value={value.payment_buffer_minutes} unit="minutes" min={5} max={60}
          hint="Between 5 and 60 minutes." onChange={next => set('payment_buffer_minutes', next)} />}
      </section>

      <section className="booking-policy-card" aria-labelledby="policy-wording-heading">
        <h3 id="policy-wording-heading">In your own words</h3>
        <label htmlFor="cancellation-note">Cancellation note (optional)</label>
        <p className="booking-policy-description">Shown alongside the booking terms. Write it as you would say it to a client; line breaks are kept.</p>
        <textarea id="cancellation-note" value={value.cancellation_message} onChange={event => set('cancellation_message', event.target.value)} rows={5}
          placeholder="Please give as much notice as you can if you need to rearrange…" />
        <Button variant="secondary" size="sm" onClick={() => focusField('late-cancellation-fee')}>Review fee setting ({value.late_cancel_charge_percent}%)</Button>
      </section>

      <section className="booking-policy-card booking-policy-preview" aria-labelledby="policy-preview-heading">
        <div className="booking-policy-preview-heading"><h3 id="policy-preview-heading">Your policy, together</h3><span>{dirty ? 'Draft' : 'Current settings'}</span></div>
        <p className="booking-policy-description">Booked appointments keep their saved cancellation fees and notice. Reschedule controls also apply to existing bookings.</p>
        <PreviewLine field="minimum-booking-notice" label="minimum booking notice">{minHours > 0 ? `Bookings need at least ${duration(minHours)} notice.` : 'No advance booking notice is required.'}</PreviewLine>
        <PreviewLine field="booking-window" label="booking window">{maxDays > 0 ? `Clients can book up to ${maxDays} days ahead.` : 'There is no advance booking limit.'}</PreviewLine>
        <PreviewLine field="cancellation-notice" label="cancellation notice">{cancelHours > 0 ? `Please give ${duration(cancelHours)} notice to cancel or reschedule.` : 'No advance cancellation notice is required.'}</PreviewLine>
        <PreviewLine field="late-cancellation-fee" label="late-cancellation fee">{cancelHours > 0 && lateFee > 0 ? `Late cancellations may be charged ${lateFee}% of the appointment price, less any deposit already paid.` : cancelHours === 0 ? 'The late-cancellation fee is inactive with no notice period.' : 'No additional late-cancellation fee is configured in Florrie.'}</PreviewLine>
        <PreviewLine field="no-show-fee" label="no-show charge">{noShowFee > 0 ? `A no-show may be charged ${noShowFee}% of the appointment price, less any deposit already paid.` : 'No additional no-show fee is configured in Florrie.'}</PreviewLine>
        <PreviewLine field="late-reschedule-deposit" label="late-reschedule deposit">{value.require_deposit_on_late_reschedule && cancelHours > 0 ? 'A late reschedule requires a fresh deposit for the new appointment.' : 'No fresh deposit rule applies to late reschedules.'}</PreviewLine>
        <PreviewLine field="reschedule-once" label="reschedule limit">{value.reschedule_once ? 'Clients can reschedule once before contacting you.' : 'Clients can reschedule more than once.'}</PreviewLine>
        <PreviewLine field="reschedule-between" label="reschedule availability">{value.reschedule_between_only ? 'Reschedules are offered beside existing appointments.' : 'Reschedules can use any available appointment time.'}</PreviewLine>
        <PreviewLine field="payment-hold" label="payment hold">{value.payment_buffer_enabled ? `Your payment hold window is ${value.payment_buffer_minutes} minutes.` : 'No custom payment hold window is set.'}</PreviewLine>
        <PreviewLine field="cancellation-note" label="cancellation note">{value.cancellation_message || 'Add a note in your own words above.'}</PreviewLine>
      </section>
    </fieldset>
  </form>;
}

const css = `
.booking-policy-editor{padding-bottom:18px;color:var(--text-primary)}
.booking-policy-intro{margin:0 0 22px}.booking-policy-intro>p{font-size:20px;font-weight:650;margin:0 0 6px}.booking-policy-intro>span{font-size:14px;line-height:1.6;color:var(--text-secondary)}
.booking-policy-fields{margin:0;padding:0;border:0;min-width:0}.booking-policy-card{padding:20px;border:1px solid var(--border-light);border-radius:20px;background:var(--bg-card);margin-bottom:16px;min-width:0}
.booking-policy-card h3{font:inherit;font-size:17px;font-weight:650;margin:0 0 8px}.booking-policy-card label{font-size:14px;font-weight:600;line-height:1.4}.booking-policy-field{padding:16px 0;border-bottom:1px solid var(--border-light)}.booking-policy-field:last-child{border-bottom:0;padding-bottom:0}.booking-policy-field-top{display:flex;align-items:center;justify-content:space-between;gap:14px}.booking-policy-field-top>label{flex:1;min-width:0}
.booking-policy-field p,.booking-policy-description{font-size:13px;line-height:1.6;color:var(--text-secondary);margin:8px 0 0}.booking-policy-number{display:flex;align-items:center;gap:7px;flex-shrink:0}.booking-policy-number input{width:70px;min-height:44px;box-sizing:border-box;text-align:center}.booking-policy-number>span{font-size:12px;color:var(--text-secondary);min-width:24px}
.booking-policy-editor input,.booking-policy-editor select,.booking-policy-editor textarea{font:inherit;font-size:15px;color:var(--text-primary);background:var(--bg-input,var(--bg-card));border:1px solid var(--border);border-radius:11px;padding:10px}
.booking-policy-editor select{display:block;width:100%;min-height:46px;margin-top:10px;box-sizing:border-box}.booking-policy-editor textarea{display:block;box-sizing:border-box;width:100%;min-height:132px;resize:vertical;margin:12px 0;line-height:1.5}
.booking-policy-editor input:focus-visible,.booking-policy-editor select:focus-visible,.booking-policy-editor textarea:focus-visible,.booking-policy-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.booking-policy-toggle{display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:24px;padding:8px 10px;min-width:78px;min-height:44px;font:inherit;font-size:12px;font-weight:600;background:var(--bg-hover);color:var(--text-secondary);cursor:pointer}.booking-policy-toggle>span{width:18px;height:18px;border-radius:50%;background:var(--text-muted)}.booking-policy-toggle[aria-checked=true]{background:var(--accent-light);color:var(--accent);border-color:var(--accent)}.booking-policy-toggle[aria-checked=true]>span{background:var(--accent)}
.booking-policy-callout{padding:12px;border-radius:12px;background:var(--bg-hover);color:var(--text-secondary);font-size:12px;line-height:1.6;margin:16px 0 0}
.booking-policy-preview{background:var(--accent-light)}.booking-policy-preview-heading{display:flex;justify-content:space-between;align-items:center;gap:10px}.booking-policy-preview-heading h3{margin:0}.booking-policy-preview-heading>span{font-size:11px;font-weight:600;white-space:nowrap;color:var(--accent)}.booking-policy-preview-row{display:flex;align-items:flex-start;gap:12px;padding:13px 0;border-bottom:1px solid var(--border-light)}.booking-policy-preview-row:last-child{border-bottom:0;padding-bottom:0}.booking-policy-preview-row>p{flex:1;min-width:0;font-size:13px;line-height:1.6;margin:0;white-space:pre-line;overflow-wrap:anywhere}.booking-policy-preview-row>button{flex-shrink:0;min-height:36px;padding-top:5px;padding-bottom:5px}
.booking-policy-savebar{position:sticky;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:12;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);padding:14px;margin:0 0 18px;box-shadow:0 6px 18px rgba(45,34,34,.06)}.booking-policy-savebar>div[role=status]{font-size:12px;color:var(--text-secondary);margin-bottom:10px}.booking-policy-save-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}.booking-policy-save-actions>.fl-btn--primary{flex:1;max-width:240px}.booking-policy-error{color:var(--danger,#9e2b32);font-size:13px;line-height:1.5;margin:12px 2px}.booking-policy-fields:disabled{opacity:.7}
@media(max-width:380px){.booking-policy-card{padding:16px}.booking-policy-number{gap:5px}.booking-policy-number input{width:60px}.booking-policy-number>span{font-size:11px}.booking-policy-preview-heading{align-items:flex-start}.booking-policy-preview-heading h3{max-width:70%}}
`;
