import { PrivateSection, useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { API_BASE } from '../lib/config.js';
import { PATCH_TEST_LEAD_HOURS } from '../lib/patch-test-policy.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

function careDate(value, wall = false, timezone = 'Europe/London') {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: wall ? 'UTC' : timezone });
}

function patchStatus(patch) {
  const date = careDate(patch.ready_at, false, patch.timezone);
  switch (patch.state) {
    case 'needed': return { label: 'Not booked', detail: 'Required before this treatment.', attention: true };
    case 'check_record': return { label: 'Check previous test', detail: 'Florrie cannot confirm that a previous test covers this treatment.', attention: true };
    case 'booked': return { label: 'Booked', detail: careDate(patch.booked_at, true) || 'Open the record to check the time.' };
    case 'waiting': return { label: `${PATCH_TEST_LEAD_HOURS}-hour wait`, detail: date ? `Waiting period ends ${date}.` : 'The waiting period has not finished yet.' };
    case 'ready': return { label: 'Waiting period finished', detail: date ? `Finished ${date}.` : '', done: true };
    case 'timing_review': return { label: 'Not enough time before treatment', detail: `The test does not leave the required ${PATCH_TEST_LEAD_HOURS} hours. Check the dates.`, attention: true };
    case 'review': return { label: 'Reaction recorded', detail: 'Read the test result before treatment.', attention: true };
    default: return { label: 'Check test record', detail: 'The patch-test status could not be confirmed.', attention: true };
  }
}
const FORM_STATUS = {
  awaiting_response: 'Awaiting reply',
  not_requested: 'Not sent yet',
  link_expired: 'Link expired',
  template_unavailable: 'Form needs setting up',
};

// The owner needs the actual test/form status, rather than the client's
// multi-stage booking instructions. Existing send and answer-reading controls
// stay here with those statuses. This component performs no writes itself.
export default function AppointmentPreparation({ appointmentId, clientId, consultation, onSendForm, sendingForm = false, sendResult }) {
  const { hidden } = useClientPrivacy();
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [answersOpen, setAnswersOpen] = useState(false);
  useEffect(() => {
    let active = true; setState({ loading: true });
    readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/consultation-forms/preparation/${appointmentId}` })
      .then(body => { if (!body.preparation?.patch || !Array.isArray(body.preparation.forms)) throw new Error(); if (active) setState({ preparation: body.preparation }); })
      .catch(() => { if (active) setState({ error: true }); });
    return () => { active = false; };
  }, [appointmentId, attempt]);
  useEffect(() => setAnswersOpen(false), [appointmentId, consultation?.response?.id]);
  if (!clientId) return null;
  if (hidden) return <PrivateSection placeholder="Patch test and consultation hidden" />;

  const prep = state.preparation;
  const response = consultation?.response;
  const forms = prep?.forms || [];
  const missing = consultation?.missing_forms || [];
  const responseFlags = response?.worth_knowing || [];
  const pendingReview = forms.some(form => form.review_required);
  const hasForms = Boolean(response || consultation?.requires_consultation || missing.length || forms.length || prep?.missing_template);
  const recordUrl = `/compliance?tab=records&clientId=${encodeURIComponent(clientId)}`;
  if (prep && !prep.patch?.required && !hasForms) return null;
  const patch = prep?.patch?.required ? patchStatus(prep.patch) : null;
  // Keep an on-file form distinct from this booking's own form. The two
  // endpoints cover different scopes; neither silently cancels out the other.
  const bookingFormPending = Boolean(response && response.appointment_id !== appointmentId && forms.some(form => form.status !== 'received'));
  let formLabel = response ? (responseFlags.length || pendingReview ? 'Review answers' : response.appointment_id === appointmentId ? 'Received' : 'Form on file')
    : prep?.missing_template ? 'Form needs setting up'
    : missing.length === 1 ? (FORM_STATUS[missing[0].status] || 'Check form status')
    : missing.length > 1 ? `${missing.length} forms outstanding`
    : consultation?.pending ? (consultation.pending.expired ? 'Link expired' : 'Awaiting reply')
    : forms.length && forms.every(form => form.status === 'received') ? (pendingReview ? 'Review answers' : 'Received')
    : consultation ? 'Not completed' : 'Check form status';
  const canSend = Boolean(consultation?.form_available && onSendForm);
  const formRows = forms.map(form => ({ id: form.id, name: form.name,
    status: form.review_required ? 'Review answers' : form.status === 'received' ? 'Received' : !form.available ? 'Form needs setting up' : 'Not completed' }));
  for (const item of missing) {
    const row = formRows.find(form => form.id === item.form_id);
    if (row) row.status = FORM_STATUS[item.status] || 'Check form status';
    else formRows.push({ id: item.form_id, name: item.form_name, status: FORM_STATUS[item.status] || 'Check form status' });
  }
  if (!response && formRows.length > 1 && !prep?.missing_template) formLabel = pendingReview ? 'Review answers' : `${formRows.length} forms`;
  const showNames = (!response || bookingFormPending) && (formRows.length > 1 || (!response && !missing.length)) ? formRows : [];

  return <section className="appointment-care" aria-label="Patch test and consultation">
    {state.loading && <p className="appointment-care-message" role="status">Checking patch test and forms…</p>}
    {state.error && <div className="appointment-care-error" role="alert">
      <div><strong>Couldn’t check patch test and forms</strong><p>Try again or open the client’s care record.</p></div>
      <Button variant="quiet" size="sm" onClick={() => setAttempt(n => n + 1)}>Retry</Button>
    </div>}
    {patch && <div className="appointment-care-row">
      <Icon name="shield" size={19} className="appointment-care-icon" />
      <div className="appointment-care-body">
        <h4>Patch test</h4>
        <p className={`appointment-care-status${patch.attention ? ' needs-attention' : ''}${patch.done ? ' is-received' : ''}`}>{patch.label}</p>
        {patch.detail && <p className="appointment-care-hint">{patch.detail}</p>}
        {prep.patch.state === 'waiting' && prep.patch.evidence?.some(item => item.date_only) && <p className="appointment-care-hint">Only the date is recorded. Add the test time in the client record for an exact waiting period.</p>}
      </div>
      <Button as="a" href={recordUrl} variant="quiet" size="sm">View test</Button>
    </div>}
    {hasForms && <div className="appointment-care-row appointment-care-form">
      <Icon name="file" size={19} className="appointment-care-icon" />
      <div className="appointment-care-body">
        <h4>Consultation</h4>
        <p className={`appointment-care-status${formLabel === 'Review answers' || formLabel === 'Form needs setting up' || formLabel === 'Link expired' ? ' needs-attention' : ''}${formLabel === 'Received' ? ' is-received' : ''}`}>{formLabel}</p>
        {response?.completed_at && <p className="appointment-care-hint">Submitted {careDate(response.completed_at)}</p>}
        {bookingFormPending && <p className="appointment-care-hint">No completed form is recorded against this appointment. You can read the form on file below.</p>}
        {formLabel === 'Awaiting reply' && <p className="appointment-care-hint">The client has a form to complete.</p>}
        {formLabel === 'Not sent yet' && <p className="appointment-care-hint">Send the client their consultation link.</p>}
        {showNames.map((form, index) => <p key={index} className="appointment-care-hint">{form.name}: {form.status}</p>)}
        {responseFlags.map((note, index) => <p className="appointment-care-flag" key={index}>{note}</p>)}
        {pendingReview && !responseFlags.length && <p className="appointment-care-flag">An answer has been flagged. Open the client care record to read it before treatment.</p>}
        {!response && forms.some(form => !form.available) && <p className="appointment-care-flag">A required form is unavailable. Check the client’s care record.</p>}
        {!response && prep?.patch?.required && !prep.patch.can_complete && <p className="appointment-care-hint">{
          prep.patch.state === 'waiting' ? 'They can sign when the waiting period ends.'
            : prep.patch.state === 'review' ? 'Review the patch-test result before asking them to sign.'
            : prep.patch.state === 'timing_review' ? 'Check the patch-test timing before they sign.'
            : prep.patch.state === 'check_record' ? 'Confirm the patch-test record before they sign.'
            : `They can sign after their patch test and the ${PATCH_TEST_LEAD_HOURS}-hour wait.`
        }</p>}
      </div>
      {response ? <Button variant="quiet" size="sm" aria-expanded={answersOpen} aria-controls={`care-answers-${appointmentId}`} onClick={() => setAnswersOpen(open => !open)}>{answersOpen ? 'Hide form' : 'Read form'}</Button>
        : canSend ? <Button variant="quiet" size="sm" onClick={onSendForm} disabled={sendingForm}>{sendingForm ? 'Sending…' : missing.length > 1 ? 'Send forms' : 'Send form'}</Button>
        : <Button as="a" href={recordUrl} variant="quiet" size="sm">{pendingReview ? 'Review form' : 'View forms'}</Button>}
      {sendResult && <p role="status" className="appointment-care-result">{sendResult}</p>}
      {response && answersOpen && <div id={`care-answers-${appointmentId}`} className="appointment-care-answers">
        <h5>{response.form_name || 'Consultation form'}</h5>
        {(response.pairs || []).map(pair => <div key={pair.field_id} className="appointment-care-answer">
          <p>{pair.question}</p>
          <div>{pair.answered ? pair.answer : 'Not answered'}</div>
          {pair.worth_knowing && <span className="appointment-care-flag">Worth knowing</span>}
        </div>)}
        {response.consent_text && <div className="appointment-care-answer"><p>Consent</p><div>{response.consent_text}</div></div>}
        {typeof response.has_signature === 'boolean' && <p className="appointment-care-hint">{response.has_signature ? 'Signature received' : 'No signature on file'}</p>}
      </div>}
    </div>}
    <a className="appointment-care-record" href={recordUrl}>Open client care record <Icon name="chevron-right" size={14} /></a>
  </section>;
}
