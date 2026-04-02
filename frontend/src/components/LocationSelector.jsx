/**
 * LocationSelector — dropdown for switching between locations.
 *
 * Only visible when beautician has 2+ locations.
 * Sets x-location-id header for all subsequent API calls.
 * Stores selection in localStorage for persistence.
 *
 * Used in the top nav bar / settings page.
 */
import { useState, useEffect, useRef } from 'react';
import { fetchRows } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';

function getToken() {
  const raw = localStorage.getItem('sb-auth-token');
  if (!raw) return null;
  try { return JSON.parse(raw)?.access_token || raw; } catch { return raw; }
}

export default function LocationSelector({ onLocationChange }) {
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(localStorage.getItem('florrie-location-id') || 'all');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    loadLocations();
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function loadLocations() {
    try {
      const data = await fetchRows('locations', { order: { column: 'is_primary', ascending: false } });
      setLocations(data || []);
    } catch {
      // Fail silently — single-location users won't have any
    }
  }

  function selectLocation(id) {
    setSelected(id);
    setOpen(false);
    localStorage.setItem('florrie-location-id', id);

    // Notify parent
    if (onLocationChange) onLocationChange(id === 'all' ? null : id);

    // Set default on backend if not "all"
    if (id !== 'all') {
      const token = getToken();
      fetch(`${API_BASE}/api/locations/${id}/set-default`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => {});
    }
  }

  // Don't render if single location or none
  if (locations.length < 2) return null;

  const current = locations.find(l => l.id === selected);

  return (
    <div ref={ref} style={styles.wrapper}>
      <button onClick={() => setOpen(!open)} style={styles.trigger}>
        <span style={styles.icon}>📍</span>
        <span style={styles.label}>{current?.name || 'All locations'}</span>
        <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={styles.dropdown}>
          <button
            onClick={() => selectLocation('all')}
            style={{
              ...styles.option,
              background: selected === 'all' ? 'var(--accent-light, #FFF0F3)' : 'transparent',
            }}
          >
            <span>All locations</span>
            {selected === 'all' && <span style={styles.check}>✓</span>}
          </button>
          {locations.map(loc => (
            <button
              key={loc.id}
              onClick={() => selectLocation(loc.id)}
              style={{
                ...styles.option,
                background: selected === loc.id ? 'var(--accent-light, #FFF0F3)' : 'transparent',
              }}
            >
              <div>
                <div style={styles.locName}>
                  {loc.name}
                  {loc.is_primary && <span style={styles.primaryBadge}>Primary</span>}
                </div>
                {loc.address && <div style={styles.locAddr}>{loc.address}</div>}
              </div>
              {selected === loc.id && <span style={styles.check}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Helper: get the current location ID from localStorage.
 * Returns null if "all" or not set.
 */
export function getCurrentLocationId() {
  const id = localStorage.getItem('florrie-location-id');
  return id && id !== 'all' ? id : null;
}

/**
 * Helper: get location header for fetch calls.
 * Add this to request headers to scope queries.
 */
export function locationHeader() {
  const id = getCurrentLocationId();
  return id ? { 'x-location-id': id } : {};
}

const styles = {
  wrapper: {
    position: 'relative',
    zIndex: 50,
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary, #2D2A26)',
  },
  icon: {
    fontSize: 14,
  },
  label: {
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: {
    fontSize: 8,
    color: 'var(--text-muted, #B5AFA8)',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    minWidth: 220,
    marginTop: 4,
    background: 'var(--bg-card, #fff)',
    border: '1px solid var(--border, #EDE9E4)',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
    overflow: 'hidden',
  },
  option: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '10px 14px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'background 0.1s',
  },
  locName: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary, #2D2A26)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  locAddr: {
    fontSize: 11,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 2,
  },
  primaryBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 4,
    background: 'var(--gold-light, #FDF8EE)',
    color: 'var(--gold-text, #8A7245)',
  },
  check: {
    color: 'var(--accent, #C76B8A)',
    fontWeight: 700,
    fontSize: 14,
  },
};
