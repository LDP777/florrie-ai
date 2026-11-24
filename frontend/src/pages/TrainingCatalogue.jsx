import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Button from '../components/ui/Button.jsx';
import CourseDescription from '../components/CourseDescription.jsx';

const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0));
export default function TrainingCatalogue() {
  const { slug } = useParams();
  const [state, setState] = useState({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setState({ loading: true });
    fetch(`${API_BASE}/api/courses/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load training dates'); if (active) setState(data); })
      .catch(error => { if (active) setState({ error: error.name === 'AbortError' ? 'Training dates took too long to load. Please try again.' : error.message }); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [slug, retry]);
  const owner = state.beautician;
  return <main style={{ minHeight: '100dvh', background: 'var(--bg, #fbf7f2)', padding: '40px 20px', color: 'var(--text, #2b2420)' }}>
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <Link to={`/book/${slug}`} style={{ color: 'var(--text-muted)', fontSize: 14 }}>← Treatment bookings</Link>
      <header style={{ margin: '32px 0' }}>
        {(owner?.logo_url || owner?.avatar_url) && <img src={owner.logo_url || owner.avatar_url} alt={`${owner.business_name || owner.first_name} logo`} style={{ width: 112, height: 72, objectFit: 'contain', marginBottom: 16 }} />}
        <p style={{ margin: '0 0 8px', color: 'var(--accent, #92405e)', fontWeight: 600 }}>{owner?.business_name || owner?.first_name || 'Training'}</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 36, margin: '0 0 12px' }}>Learn with us</h1>
        <p style={{ lineHeight: 1.6 }}>Choose a course, then one of the training dates available below.</p>
      </header>
      {state.loading && <p role="status">Loading training dates…</p>}
      {state.error && <div role="alert"><p>{state.error}</p><Button onClick={() => setRetry(x => x + 1)}>Try again</Button></div>}
      {!state.loading && !state.error && state.courses?.length === 0 && <p>There are no training dates open just now. Please check back for the next dates.</p>}
      {(state.courses || []).map(course => {
        const available = course.dates.filter(date => !date.is_full && !date.closed);
        const first = available[0] || course.dates[0];
        return <article key={course.id} style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, #e7dcd5)', borderRadius: 24, padding: 24, marginBottom: 16 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, margin: '0 0 10px' }}>{course.name}</h2>
          <CourseDescription text={course.description} style={{ lineHeight: 1.6 }} />
          <p style={{ color: 'var(--text-muted)' }}>{first?.duration}{first?.location ? ` · ${first.location}` : ''}</p>
          <p><strong>{money(first?.price)}</strong>{Number(first?.deposit) > 0 ? ` · ${money(first.deposit)} deposit` : ''}</p>
          <p>{available.length ? `${available.length} ${available.length === 1 ? 'date' : 'dates'} available · next ${first.date_label}` : 'All current dates are full'}</p>
          <Link to={`/training/${slug}/${course.id}`} style={{ display: 'inline-flex', minHeight: 44, alignItems: 'center', padding: '0 18px', borderRadius: 18, background: 'var(--accent, #92405e)', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>View course & dates →</Link>
        </article>;
      })}
    </div>
  </main>;
}
