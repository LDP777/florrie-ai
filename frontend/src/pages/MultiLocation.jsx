import { useState, useEffect } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const locations = [
  {
    id: 'loc-1', name: 'Ellindigo — City Centre', address: '14 King St, Manchester M2 6AG',
    status: 'active', isPrimary: true,
    staff: 3, clients: 248, weeklyRevenue: 4280, utilisation: 78,
    hours: { mon: '11:00–19:00', tue: '11:00–19:00', wed: '11:00–18:00', thu: '11:00–19:00', fri: '10:00–17:00', sat: 'Closed', sun: 'Closed' },
    topTreatment: 'Brow Lamination', monthlyGrowth: 12,
  },
  {
    id: 'loc-2', name: 'Ellindigo — Northern Quarter', address: '82 Tib St, Manchester M4 1LG',
    status: 'active', isPrimary: false,
    staff: 2, clients: 156, weeklyRevenue: 2840, utilisation: 65,
    hours: { mon: '10:00–18:00', tue: '10:00–18:00', wed: '10:00–18:00', thu: '10:00–20:00', fri: '10:00–18:00', sat: '10:00–16:00', sun: 'Closed' },
    topTreatment: 'Lash Lift & Tint', monthlyGrowth: 8,
  },
  {
    id: 'loc-3', name: 'Ellindigo — Didsbury', address: '22 Wilmslow Rd, Didsbury M20 6RH',
    status: 'setup', isPrimary: false,
    staff: 0, clients: 0, weeklyRevenue: 0, utilisation: 0,
    hours: {}, topTreatment: '—', monthlyGrowth: 0,
  },
];

const crossBookings = [
  { client: 'Jessica M.', from: 'City Centre', to: 'Northern Quarter', treatment: 'Lip Filler', date: 'Mar 26', reason: 'Earlier availability' },
  { client: 'Sarah C.', from: 'Northern Quarter', to: 'City Centre', treatment: 'Brow Lamination', date: 'Mar 25', reason: 'Preferred stylist' },
  { client: 'Emma T.', from: 'City Centre', to: 'Northern Quarter', treatment: 'Gel Manicure', date: 'Mar 24', reason: 'Closer to home' },
];

const tabs = ['Overview', 'Locations', 'Cross-Booking', 'Compare'];

export default function MultiLocation() {
  const { beautician, loading: bLoading } = useBeautician();
  const [locs, setLocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(0);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => { if (beautician) loadLocations(); }, [beautician]);

  async function loadLocations() {
    setLoading(true);
    setError(null);
    try {
      {
        const { data, error: err } = await supabase
          .from('locations')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('is_primary', { ascending: false });
        if (err) throw err;
        setLocs(data || []);
      }
    } catch (err) {
      logger.error('Load locations error:', err);
      setError('Failed to load locations');
      setLocs([]);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
  }

  const activeLocations = locs.filter(l => l.status === 'active');
  const totalRevenue = activeLocations.reduce((s, l) => s + l.weeklyRevenue, 0);
  const totalClients = activeLocations.reduce((s, l) => s + l.clients, 0);
  const totalStaff = activeLocations.reduce((s, l) => s + l.staff, 0);
  const avgUtil = activeLocations.length > 0 ? Math.round(activeLocations.reduce((s, l) => s + l.utilisation, 0) / activeLocations.length) : 0;

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Multi-Location</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Manage branches, compare performance, cross-book clients</p>
      </div>

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>YOUR NETWORK</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{locs.length} locations</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{activeLocations.length} active · {locs.filter(l => l.status === 'setup').length} setting up</div>
          </div>
          <div style={{ fontSize: 40 }}>🏢</div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[{ label: 'Weekly rev', val: `£${totalRevenue.toLocaleString()}` }, { label: 'Total clients', val: totalClients }, { label: 'Staff', val: totalStaff }, { label: 'Avg util', val: `${avgUtil}%` }].map(s => (
            <div key={s.label} style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{s.val}</div>
              <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* Overview */}
      {tab === 0 && (
        <div>
          {locs.map(loc => (
            <div key={loc.id} style={{ ...ds.card, marginBottom: 12, borderLeft: `3px solid ${loc.status === 'active' ? 'var(--success)' : 'var(--gold)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={type.heading}>{loc.name}</span>
                    {loc.isPrimary && <span style={{ ...ds.badge, ...ds.badgeGold }}>Primary</span>}
                  </div>
                  <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{loc.address}</div>
                </div>
                <span style={{ ...ds.badge, ...(loc.status === 'active' ? ds.badgeSuccess : ds.badgeWarning) }}>{loc.status}</span>
              </div>
              {loc.status === 'active' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  {[{ label: 'Revenue', val: `£${loc.weeklyRevenue.toLocaleString()}` }, { label: 'Clients', val: loc.clients }, { label: 'Staff', val: loc.staff }, { label: 'Utilisation', val: `${loc.utilisation}%` }].map(s => (
                    <div key={s.label} style={{ flex: 1, ...ds.statCard, padding: 8, textAlign: 'center' }}>
                      <div style={{ ...ds.statValue, fontSize: 14 }}>{s.val}</div>
                      <div style={{ ...ds.statLabel, fontSize: 9 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}
              {loc.status === 'setup' && (
                <button style={{ ...ds.btnPrimary, marginTop: 10, padding: '10px 0', fontSize: 13 }}>Complete Setup →</button>
              )}
            </div>
          ))}
          <button style={{ ...ds.btnSecondary, width: '100%', marginTop: 8 }}>+ Add New Location</button>
        </div>
      )}

      {/* Locations Detail */}
      {tab === 1 && (
        <div>
          {locs.filter(l => l.status === 'active').map((loc, i) => (
            <div key={loc.id} style={{ ...ds.card, marginBottom: 12, cursor: 'pointer' }} onClick={() => setExpanded(expanded === i ? null : i)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={type.heading}>{loc.name}</span>
                  {loc.isPrimary && <span style={{ ...ds.badge, ...ds.badgeGold, marginLeft: 8 }}>Primary</span>}
                </div>
                <span style={{ fontSize: 14, color: 'var(--text-muted)', transform: expanded === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
              </div>

              {expanded === i && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ ...type.bodySmall, marginBottom: 12 }}>{loc.address}</div>

                  <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>OPENING HOURS</div>
                  {Object.entries(loc.hours).map(([day, hrs]) => (
                    <div key={day} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span style={{ ...type.body, fontSize: 12, textTransform: 'capitalize', width: 40 }}>{day}</span>
                      <span style={{ ...type.mono, fontSize: 12, color: hrs === 'Closed' ? 'var(--text-muted)' : 'var(--text-primary)' }}>{hrs}</span>
                    </div>
                  ))}

                  <div style={{ ...ds.divider }} />

                  <div style={{ display: 'flex', gap: 8 }}>
                    {[{ label: 'Top treatment', val: loc.topTreatment }, { label: 'Monthly growth', val: `+${loc.monthlyGrowth}%` }].map(s => (
                      <div key={s.label} style={{ flex: 1 }}>
                        <div style={{ ...type.caption, fontSize: 10, marginBottom: 2 }}>{s.label}</div>
                        <div style={{ ...type.body, fontSize: 13 }}>{s.val}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button style={{ ...ds.btnGhost, flex: 1, fontSize: 11, background: 'var(--accent-light)', color: 'var(--accent)' }}>Edit Hours</button>
                    <button style={{ ...ds.btnGhost, flex: 1, fontSize: 11 }}>Manage Staff</button>
                    <button style={{ ...ds.btnGhost, flex: 1, fontSize: 11 }}>View Reports</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Cross-Booking */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 16, background: 'var(--bg-warm)' }}>
            <div style={{ ...type.heading, marginBottom: 4 }}>Cross-Location Booking</div>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>Clients can book at any of your locations. florrie.ai automatically suggests the nearest branch with availability.</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <div style={{ flex: 1, ...ds.statCard, padding: 10, textAlign: 'center' }}>
                <div style={{ ...ds.statValue, fontSize: 18 }}>12</div>
                <div style={ds.statLabel}>Cross-books (30d)</div>
              </div>
              <div style={{ flex: 1, ...ds.statCard, padding: 10, textAlign: 'center' }}>
                <div style={{ ...ds.statValue, fontSize: 18 }}>£1,840</div>
                <div style={ds.statLabel}>Revenue saved</div>
              </div>
            </div>
          </div>

          <div style={{ ...ds.sectionTitle, marginBottom: 10 }}>RECENT CROSS-BOOKINGS</div>
          {crossBookings.map((cb, i) => (
            <div key={i} style={{ ...ds.card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={type.heading}>{cb.client}</span>
                <span style={{ ...type.mono, fontSize: 11, color: 'var(--text-muted)' }}>{cb.date}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ ...ds.badge, background: 'var(--bg-subtle)' }}>{cb.from}</span>
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <span style={{ ...ds.badge, ...ds.badgeAccent }}>{cb.to}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...type.bodySmall, fontSize: 12 }}>{cb.treatment}</span>
                <span style={{ ...type.bodySmall, fontSize: 12, fontStyle: 'italic' }}>{cb.reason}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Compare */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 12 }}>LOCATION COMPARISON</div>
          {['Revenue', 'Clients', 'Utilisation', 'Staff', 'Growth'].map(metric => {
            const vals = activeLocations.map(l => {
              if (metric === 'Revenue') return l.weeklyRevenue;
              if (metric === 'Clients') return l.clients;
              if (metric === 'Utilisation') return l.utilisation;
              if (metric === 'Staff') return l.staff;
              return l.monthlyGrowth;
            });
            const maxVal = Math.max(...vals);
            return (
              <div key={metric} style={{ ...ds.card, marginBottom: 10 }}>
                <div style={{ ...type.heading, fontSize: 13, marginBottom: 10 }}>{metric}</div>
                {activeLocations.map((loc, i) => (
                  <div key={loc.id} style={{ marginBottom: i < activeLocations.length - 1 ? 8 : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ ...type.bodySmall, fontSize: 12 }}>{loc.name.split('—')[1]?.trim() || loc.name}</span>
                      <span style={{ ...type.mono, fontSize: 12 }}>
                        {metric === 'Revenue' ? `£${vals[i].toLocaleString()}` : metric === 'Utilisation' || metric === 'Growth' ? `${vals[i]}%` : vals[i]}
                      </span>
                    </div>
                    <div style={{ height: 8, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: maxVal > 0 ? `${(vals[i] / maxVal) * 100}%` : '0%',
                        background: i === 0 ? 'var(--accent)' : 'var(--gold)',
                        borderRadius: 4, transition: 'width 0.4s ease',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>💡</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Northern Quarter has 13% lower utilisation but 8% growth — it's filling up. City Centre has spare Thursday capacity that could absorb overflow from NQ's fully-booked Saturdays.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
