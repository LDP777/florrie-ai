import { useState, useEffect } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';

const tabs = ['Overview', 'Locations'];

export default function MultiLocation() {
  const { beautician, loading: bLoading } = useBeautician();
  const [locs, setLocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', address: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (beautician) loadLocations(); }, [beautician]);

  async function loadLocations() {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('locations')
        .select('*')
        .eq('beautician_id', beautician.id)
        .order('is_primary', { ascending: false });
      if (err) throw err;
      setLocs(data || []);
    } catch (err) {
      logger.error('Load locations error:', err);
      setError('Failed to load locations');
      setLocs([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddLocation() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const { data, error: err } = await supabase
        .from('locations')
        .insert({
          beautician_id: beautician.id,
          name: form.name.trim(),
          address: form.address.trim() || null,
          status: 'setup',
          is_primary: locs.length === 0,
        })
        .select()
        .single();
      if (err) throw err;
      setLocs(prev => [...prev, data]);
      setForm({ name: '', address: '' });
      setAdding(false);
    } catch (err) {
      logger.error('Add location error:', err);
      setError('Failed to add location');
    } finally {
      setSaving(false);
    }
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
  }

  const activeLocations = locs.filter(l => l.status === 'active');
  const settingUp = locs.filter(l => l.status === 'setup');

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Multi-Location</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Manage your branches</p>
      </div>

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>YOUR NETWORK</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{locs.length} {locs.length === 1 ? 'location' : 'locations'}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{activeLocations.length} active · {settingUp.length} setting up</div>
          </div>
          <div style={{ fontSize: 40 }}><Icon name="map-pin" size={40} /></div>
        </div>
      </div>

      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* Add location form (shared by both tabs) */}
      {adding && (
        <div style={{ ...ds.card, marginBottom: 16 }}>
          <div style={{ ...type.heading, fontSize: 14, marginBottom: 10 }}>New location</div>
          <input
            type="text"
            placeholder="Location name"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Address (optional)"
            value={form.address}
            onChange={e => setForm({ ...form, address: e.target.value })}
            style={{ ...inputStyle, marginTop: 8 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={handleAddLocation} disabled={saving || !form.name.trim()} style={{ ...ds.btnPrimary, flex: 1, padding: '10px 0', fontSize: 13, opacity: saving || !form.name.trim() ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Add location'}</button>
            <button onClick={() => setAdding(false)} style={{ ...ds.btnSecondary, flex: 1, padding: '10px 0', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Overview */}
      {tab === 0 && (
        <div>
          {locs.length === 0 && !adding && (
            <EmptyState
              icon="map-pin"
              title="No locations yet"
              subtitle="Add a branch to manage more than one place from one account."
              actionLabel="+ Add location"
              onAction={() => setAdding(true)}
            />
          )}
          {locs.map(loc => (
            <div key={loc.id} style={{ ...ds.card, marginBottom: 12, borderLeft: `3px solid ${loc.status === 'active' ? 'var(--success)' : 'var(--gold)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={type.heading}>{loc.name}</span>
                    {loc.is_primary && <span style={{ ...ds.badge, ...ds.badgeGold }}>Primary</span>}
                  </div>
                  {loc.address && <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{loc.address}</div>}
                </div>
                <span style={{ ...ds.badge, ...(loc.status === 'active' ? ds.badgeSuccess : ds.badgeWarning) }}>{loc.status}</span>
              </div>
            </div>
          ))}
          {locs.length > 0 && (
            <button onClick={() => setAdding(true)} style={{ ...ds.btnSecondary, width: '100%', marginTop: 8 }}>+ Add New Location</button>
          )}
        </div>
      )}

      {/* Locations Detail */}
      {tab === 1 && (
        <div>
          {locs.length === 0 && !adding && (
            <EmptyState
              icon="map-pin"
              title="No locations yet"
              subtitle="Once you add a location, its details will show here."
              actionLabel="+ Add location"
              onAction={() => setAdding(true)}
            />
          )}
          {locs.map((loc, i) => (
            <div key={loc.id} style={{ ...ds.card, marginBottom: 12, cursor: 'pointer' }} onClick={() => setExpanded(expanded === i ? null : i)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={type.heading}>{loc.name}</span>
                  {loc.is_primary && <span style={{ ...ds.badge, ...ds.badgeGold, marginLeft: 8 }}>Primary</span>}
                </div>
                <span style={{ fontSize: 14, color: 'var(--text-muted)', transform: expanded === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
              </div>

              {expanded === i && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ ...type.bodySmall, fontSize: 12 }}>Status</span>
                    <span style={{ ...type.body, fontSize: 13, textTransform: 'capitalize' }}>{loc.status}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ ...type.bodySmall, fontSize: 12 }}>Address</span>
                    <span style={{ ...type.body, fontSize: 13 }}>{loc.address || 'Not set'}</span>
                  </div>
                  {loc.phone && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span style={{ ...type.bodySmall, fontSize: 12 }}>Phone</span>
                      <span style={{ ...type.body, fontSize: 13 }}>{loc.phone}</span>
                    </div>
                  )}
                  {loc.email && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span style={{ ...type.bodySmall, fontSize: 12 }}>Email</span>
                      <span style={{ ...type.body, fontSize: 13 }}>{loc.email}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-light, #ede7e3)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
  background: 'var(--bg, #FBF6F1)',
  color: 'var(--text-primary, #241B17)',
};
