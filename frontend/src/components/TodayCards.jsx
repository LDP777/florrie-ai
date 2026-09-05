import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { dedupeFetch } from '../lib/dedupe-fetch.js';
import { salonClock, todayOverview, decisionOverview, appointmentName, appointmentTime } from '../lib/today-overview.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

const money = pence => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: 'GBP', minimumFractionDigits: pence % 100 ? 2 : 0,
}).format(pence / 100);

async function read(path) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Session unavailable');
  const res = await dedupeFetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
  });
  if (!res.ok) throw new Error('Could not load Today');
  return res.json();
}

function useTodayRefresh() {
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = setInterval(visible, 60_000);
    window.addEventListener('florrie:refresh-counts', refresh);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('florrie:refresh-counts', refresh);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return [revision, refresh];
}

function LoadError({ children, retry }) {
  return <div className="today-load-error" role="status">
    <Icon name="refresh" size={19} />
    <p>{children}</p>
    <Button variant="secondary" onClick={retry}>Retry</Button>
  </div>;
}

function ChannelStatus({ beautician, onNav }) {
  const whatsapp = beautician?.whatsapp_connected;
  const instagram = beautician?.instagram_page_id;
  const pending = beautician?.whatsapp_pending_activation;
  const label = whatsapp && instagram ? 'WhatsApp and Instagram connected'
    : whatsapp ? 'WhatsApp connected'
    : pending ? 'WhatsApp activating'
    : instagram ? 'Instagram connected' : 'Connect Instagram or WhatsApp';
  const path = whatsapp && instagram ? '/inbox'
    : whatsapp || pending ? '/whatsapp' : instagram ? '/inbox' : '/settings';
  return <Button variant="quiet" className="today-inbox-link today-channel" onClick={() => onNav(path)}>
    <Icon name={whatsapp || instagram ? 'check' : 'message'} size={16} />
    <span>{label}</span><Icon name="chevron-right" size={16} />
  </Button>;
}

export function TodaySummary({ beautician, onNav }) {
  const [state, setState] = useState({ status: 'loading' });
  const [revision, refresh] = useTodayRefresh();
  useEffect(() => {
    if (!beautician?.id) return;
    let cancelled = false;
    async function load() {
      try {
        const clock = salonClock(new Date(), beautician.timezone);
        const tomorrow = new Date(`${clock.date}T12:00:00Z`);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const [appointments, counts] = await Promise.all([
          read(`/api/appointments?from=${clock.date}&to=${tomorrow.toISOString().slice(0, 10)}&per_page=100`),
          read('/api/agents/counts').catch(() => null),
        ]);
        if (!Array.isArray(appointments?.data)) throw new Error('Diary unavailable');
        if (!cancelled) setState({ status: 'ready', overview: todayOverview(appointments.data, clock),
          inbox: Number.isInteger(counts?.inbox) && counts.inbox >= 0 ? counts.inbox : null });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [beautician?.id, beautician?.timezone, revision]);

  if (state.status === 'error') return <section className="today-card">
    <h2 className="today-section-title">Your day</h2>
    <LoadError retry={refresh}>Couldn't load your diary. Try again to see who's next.</LoadError>
  </section>;
  if (state.status === 'loading') return <section className="today-card" aria-busy="true" aria-label="Loading your day">
    <span className="today-eyebrow">Your day</span>
    <div className="today-skeleton today-skeleton--headline" />
    <div className="today-skeleton" /><div className="today-skeleton" />
  </section>;

  const { overview: day, inbox } = state;
  const focus = day.focus;
  const openAppointment = appointment => onNav(`/calendar/week?date=${day.date}&appt=${appointment.id}`);
  const treatment = focus?.treatments?.name || focus?.treatment_name;

  return <section className="today-card today-agenda" aria-label="Your day">
    <div className="today-card-heading">
      <span className="today-eyebrow">Your day</span>
      <Button variant="quiet" className="today-text-button" onClick={() => onNav(`/calendar/week?date=${day.date}`)}>
        Open diary <Icon name="arrow-right" size={16} />
      </Button>
    </div>
    {focus ? <Button variant="quiet" className="today-next" onClick={() => openAppointment(focus)}
      aria-label={`Open ${appointmentName(focus)} at ${appointmentTime(focus)}`}>
      <span className="today-next-label"><span className="today-status-dot" />{day.current ? 'Scheduled now' : 'Next client'}</span>
      <span className="today-next-main">
        <span className="today-next-time">{appointmentTime(focus)}</span>
        <span className="today-avatar" aria-hidden="true">{appointmentName(focus).split(' ').map(n => n[0]).slice(0, 2).join('')}</span>
      </span>
      <span className="today-next-name">{appointmentName(focus)}</span>
      {treatment && <span className="today-next-treatment">{treatment}</span>}
      <span className="today-next-footer">View appointment <Icon name="arrow-right" size={17} /></span>
    </Button> : <div className="today-next today-next--empty">
      <Icon name={day.diary.length ? 'check' : 'sun'} size={25} />
      <h2>{day.diary.length ? 'No more clients due' : 'Room to breathe'}</h2>
      <p>{day.diary.length ? 'Your appointments are in the diary below.' : 'No confirmed appointments today. Your calendar is here when you need it.'}</p>
    </div>}

    <div className="today-totals">
      <div><span className="today-muted">Completed value</span><strong>{money(day.completedValue)}</strong><small>{day.completed} of {day.diary.length} appointments</small></div>
      <div><span className="today-muted">Potential today</span><strong>{money(day.potentialValue)}</strong><small>{day.pending ? 'Includes pending bookings' : 'On your diary'}</small></div>
    </div>
    {day.needsPrice > 0 && <Button variant="quiet" className="today-price-note" onClick={() => onNav(`/calendar/week?date=${day.date}`)}>
      <Icon name="tag" size={16} /> {day.needsPrice} {day.needsPrice === 1 ? 'booking is' : 'bookings are'} priced at £0
    </Button>}

    {day.diary.length > 0 && <details className="today-disclosure">
      <summary><span>Today's appointments <span className="today-small-count">{day.diary.length}</span></span><Icon name="chevron-down" size={16} /></summary>
      <ol className="today-appointments">
        {day.diary.map(appointment => <li key={appointment.id}>
          <Button variant="quiet" className="today-appointment" onClick={() => openAppointment(appointment)}>
            <span className="today-appointment-time">{appointmentTime(appointment)}</span>
            <span className="today-appointment-person"><strong>{appointmentName(appointment)}</strong><small>{appointment.treatments?.name || appointment.treatment_name || 'Appointment'}</small></span>
            {appointment.status === 'completed' ? <span className="today-done"><Icon name="check" size={14} />Done</span> : <Icon name="chevron-right" size={16} />}
          </Button>
        </li>)}
      </ol>
    </details>}
    <Button variant="quiet" className="today-inbox-link" onClick={() => onNav('/inbox')}>
      <Icon name="message" size={18} />
      <span>{inbox === null ? 'Open inbox · count unavailable' : inbox ? `${inbox} ${inbox === 1 ? 'message needs' : 'messages need'} you` : 'No messages waiting'}</span>
      <Icon name="arrow-right" size={16} />
    </Button>
    <ChannelStatus beautician={beautician} onNav={onNav} />
  </section>;
}

export function ApprovalCard({ onNav, beauticianId }) {
  const [state, setState] = useState({ status: 'loading', items: [] });
  const [revision, refresh] = useTodayRefresh();
  useEffect(() => {
    let cancelled = false;
    Promise.all([read('/api/outbound/pending'), read('/api/escalations')])
      .then(([pending, escalations]) => {
        const items = decisionOverview(pending, escalations);
        if (!cancelled) setState({ status: 'ready', items });
      })
      .catch(() => { if (!cancelled) setState({ status: 'error', items: [] }); });
    return () => { cancelled = true; };
  }, [beauticianId, revision]);

  const count = state.items.length;
  const first = state.items[0];
  return <section className={`today-card today-decisions${count ? ' today-decisions--waiting' : ''}`} aria-label="Your decisions">
    <div className="today-card-heading"><span className="today-eyebrow">A moment of your time</span><Icon name="flower" size={21} /></div>
    {state.status === 'loading' ? <div aria-busy="true" aria-label="Loading decisions"><div className="today-skeleton" /></div>
      : state.status === 'error' ? <LoadError retry={refresh}>Couldn't check your drafts. Your decision queue is still in Outbox.</LoadError>
      : count ? <>
        <h2 className="today-decision-title"><span>{count}</span> {count === 1 ? 'decision' : 'decisions'} for you</h2>
        <p className="today-muted">Florrie's drafts are waiting for your review.</p>
        {first?.draft && <details className="today-draft-preview">
          <summary><span>Preview for {appointmentName(first)}</span><Icon name="chevron-down" size={16} /></summary>
          <blockquote>{first.draft}</blockquote>
          <span className="today-muted">Draft · not sent</span>
        </details>}
      </> : <div className="today-clear"><Icon name="check" size={22} /><div><h2>No drafts waiting</h2><p>You're up to date with your decisions.</p></div></div>}
    {state.status !== 'loading' && <Button variant={count ? 'primary' : 'quiet'} fullWidth onClick={() => onNav('/outbox')}>
      {count ? `Review ${count === 1 ? 'draft' : 'drafts'}` : 'Open Outbox'} <Icon name="arrow-right" size={17} />
    </Button>}
  </section>;
}
