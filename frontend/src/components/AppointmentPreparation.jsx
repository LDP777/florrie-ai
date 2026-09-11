import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { API_BASE } from '../lib/config.js';
import Button from './ui/Button.jsx';
import { PreparationChecklist } from './BookingPreparation.jsx';

export default function AppointmentPreparation({ appointmentId, clientId }) {
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setState({ loading: true });
    readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/consultation-forms/preparation/${appointmentId}` })
      .then(body => { if (!body.preparation) throw new Error(); if (active) setState({ preparation: body.preparation }); })
      .catch(() => { if (active) setState({ error: true }); });
    return () => { active = false; };
  }, [appointmentId, attempt]);
  if (!clientId) return null;
  const prep = state.preparation;
  const flagged = prep?.forms.some(f => f.review_required) || ['review', 'check_record', 'timing_review'].includes(prep?.patch.state) || prep?.missing_template;
  return <details style={{ marginTop: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 12 }}>
    <summary style={{ minHeight: 32, cursor: 'pointer', fontWeight: 600 }}>Booking preparation{flagged ? ' · Needs your review' : ''}</summary>
    {state.loading ? <p role="status">Checking preparation…</p> : state.error ? <div role="alert"><p>Preparation could not be checked.</p><Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry preparation</Button></div>
      : <><PreparationChecklist preparation={prep} owner /><a href={`/compliance?tab=records&clientId=${encodeURIComponent(clientId)}`} style={{ color: 'var(--accent)' }}>Open client care record</a></>}
  </details>;
}
