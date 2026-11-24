import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Button from '../components/ui/Button.jsx';
import CourseDescription from '../components/CourseDescription.jsx';
import Icon from '../components/ui/Icon.jsx';
import { TrainingHeader, TrainingFooter, trainingTheme } from '../components/TrainingPublic.jsx';

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
  return <main className="training-page training-catalogue" style={trainingTheme(owner)}>
    <div className="training-shell">
      <TrainingHeader owner={owner} to={`/book/${slug}`} label="Treatment bookings" />
      <header className="training-intro">
        <p className="training-eyebrow">Training</p>
        <h1>Learn with us</h1>
        <p>Find your course. Choose a date that suits you.</p>
      </header>
      {state.loading && <p role="status">Loading training dates…</p>}
      {state.error && <div role="alert"><p>{state.error}</p><Button onClick={() => setRetry(x => x + 1)}>Try again</Button></div>}
      {!state.loading && !state.error && state.courses?.length === 0 && <p>There are no training dates open just now. Please check back for the next dates.</p>}
      {(state.courses || []).map(course => {
        const available = course.dates.filter(date => !date.is_full && !date.closed && !date.in_the_past);
        const first = available[0] || course.dates[0];
        const pricedDates = available.length ? available : course.dates;
        const pricesVary = new Set(pricedDates.map(date => Number(date.price))).size > 1;
        const depositsVary = new Set(pricedDates.map(date => Number(date.deposit || 0))).size > 1;
        return <article key={course.id} className="training-course-card">
          <h2>{course.name}</h2>
          <ul className="training-meta">
            {first?.duration && <li><Icon name="clock" size={15} />{first.duration}</li>}
            {first?.location && <li><Icon name="map-pin" size={15} />{first.location}</li>}
          </ul>
          <div className="training-outline"><CourseDescription text={course.description} previewLines={4} style={{ margin: '0 0 8px' }} /></div>
          <div className="training-course-footer">
            <div className="training-card-price">
              <strong>{pricesVary ? `From ${money(Math.min(...pricedDates.map(date => Number(date.price))))}` : money(first?.price)}</strong>
              {depositsVary ? <span>Deposit varies by date</span> : Number(first?.deposit) > 0 && <span>{money(first.deposit)} deposit</span>}
            </div>
            <p className="training-next"><Icon name="calendar" size={15} /><span>{available.length ? <><strong>{available.length} {available.length === 1 ? 'date' : 'dates'} available</strong>{first.date_label && <><br />Next: {first.date_label}</>}</> : 'No dates available just now'}</span></p>
            <Link to={`/training/${slug}/${course.id}`} className="training-link">View course & dates →</Link>
          </div>
        </article>;
      })}
      <TrainingFooter />
    </div>
  </main>;
}
