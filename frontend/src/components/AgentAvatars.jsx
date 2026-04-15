/**
 * AgentAvatars — live status widget showing Florrie's 6 AI agents.
 *
 * Each agent is a small avatar circle with a pulsing ring when active.
 * Tapping an avatar shows its latest action in a popover.
 *
 * Used on Dashboard + designed to match the iOS widget data shape
 * so the native WidgetKit extension can mirror this layout.
 */
import { useState, useEffect, useRef } from 'react';
import { API_BASE } from '../lib/config.js';

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token — find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}

export default function AgentAvatars() {
  const [agents, setAgents] = useState(null);
  const [summary, setSummary] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(false);
  const popRef = useRef(null);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  // Close popover on outside click
  useEffect(() => {
    function handleClick(e) {
      if (popRef.current && !popRef.current.contains(e.target)) {
        setSelected(null);
      }
    }
    if (selected !== null) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selected]);

  async function fetchStatus() {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/agents/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAgents(data.agents);
      setSummary(data.summary);
      setError(false);
    } catch {
      setError(true);
    }
  }

  if (error || !agents) return null; // silent fail — widget is supplementary

  return (
    <div style={styles.wrapper}>
      {/* Headline */}
      <div style={styles.header}>
        <span style={styles.headerIcon}>✦</span>
        <span style={styles.headerText}>Your AI Team</span>
        <span style={styles.headerCount}>
          {summary?.activeAgents || 0}/{summary?.totalAgents || 6} active
        </span>
      </div>

      {/* Agent grid */}
      <div style={styles.grid}>
        {agents.map((agent, i) => (
          <button
            key={agent.id}
            style={styles.agentButton}
            onClick={() => setSelected(selected === i ? null : i)}
            aria-label={`${agent.name} — ${agent.statusLine}`}
          >
            {/* Pulse ring for active agents */}
            {agent.isActive && <span style={{ ...styles.pulse, borderColor: agent.colour }} />}

            {/* Avatar circle */}
            <span
              style={{
                ...styles.avatar,
                background: agent.isActive
                  ? `${agent.colour}18`
                  : 'var(--bg-hover, #F5F2EF)',
                borderColor: agent.isActive ? agent.colour : 'transparent',
              }}
            >
              {agent.avatar}
            </span>

            {/* Name */}
            <span style={{
              ...styles.agentName,
              color: agent.isActive
                ? 'var(--text-primary, #2D2A26)'
                : 'var(--text-muted, #B5AFA8)',
            }}>
              {agent.name}
            </span>

            {/* Action count badge */}
            {agent.actionsToday > 0 && (
              <span style={{ ...styles.badge, background: agent.colour }}>
                {agent.actionsToday}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Popover for selected agent */}
      {selected !== null && agents[selected] && (
        <div ref={popRef} style={styles.popover}>
          <div style={styles.popAgent}>
            <span style={styles.popAvatar}>{agents[selected].avatar}</span>
            <div>
              <div style={styles.popName}>{agents[selected].name}</div>
              <div style={styles.popStatus}>{agents[selected].statusLine}</div>
            </div>
          </div>
          <div style={styles.popStats}>
            <div style={styles.popStat}>
              <span style={styles.popStatNum}>{agents[selected].actionsToday}</span>
              <span style={styles.popStatLabel}>today</span>
            </div>
            <div style={styles.popDivider} />
            <div style={styles.popStat}>
              <span style={styles.popStatNum}>{agents[selected].actionsThisWeek}</span>
              <span style={styles.popStatLabel}>this week</span>
            </div>
          </div>
        </div>
      )}

      {/* Summary bar */}
      {summary && summary.totalActionsToday > 0 && (
        <div style={styles.summaryBar}>
          {summary.headline}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    position: 'relative',
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid var(--border, #EDE9E4)',
    padding: '16px 16px 12px',
    marginBottom: 16,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 14,
  },
  headerIcon: {
    fontSize: 14,
    color: 'var(--accent, #C76B8A)',
  },
  headerText: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  headerCount: {
    marginLeft: 'auto',
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    fontWeight: 500,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  agentButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '10px 4px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    position: 'relative',
    borderRadius: 12,
    transition: 'background 0.15s',
    WebkitTapHighlightColor: 'transparent',
  },
  pulse: {
    position: 'absolute',
    top: 6,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 42,
    height: 42,
    borderRadius: '50%',
    border: '2px solid',
    opacity: 0.4,
    animation: 'agentPulse 2s ease-in-out infinite',
    pointerEvents: 'none',
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    border: '2px solid',
    transition: 'all 0.2s',
  },
  agentName: {
    fontSize: 11,
    fontWeight: 500,
    transition: 'color 0.2s',
    whiteSpace: 'nowrap',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: '50%',
    transform: 'translateX(18px)',
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    fontSize: 10,
    fontWeight: 700,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
  },
  popover: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: '100%',
    marginBottom: 8,
    background: 'var(--bg-card, #fff)',
    borderRadius: 14,
    border: '1px solid var(--border, #EDE9E4)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
    padding: 16,
    zIndex: 10,
    animation: 'fadeIn 0.15s ease-out',
  },
  popAgent: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  popAvatar: {
    fontSize: 28,
  },
  popName: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  popStatus: {
    fontSize: 13,
    color: 'var(--text-secondary, #8B6F5E)',
    marginTop: 2,
  },
  popStats: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    paddingTop: 12,
    borderTop: '1px solid var(--border, #EDE9E4)',
  },
  popStat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
  },
  popStatNum: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary, #2D2A26)',
  },
  popStatLabel: {
    fontSize: 11,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 2,
  },
  popDivider: {
    width: 1,
    height: 32,
    background: 'var(--border, #EDE9E4)',
  },
  summaryBar: {
    marginTop: 12,
    padding: '8px 12px',
    borderRadius: 10,
    background: 'var(--accent-light, #FFF0F3)',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--accent, #C76B8A)',
    textAlign: 'center',
  },
};

// Inject keyframe animation once
if (typeof document !== 'undefined' && !document.getElementById('agent-pulse-keyframes')) {
  const style = document.createElement('style');
  style.id = 'agent-pulse-keyframes';
  style.textContent = `
    @keyframes agentPulse {
      0%, 100% { transform: translateX(-50%) scale(1); opacity: 0.4; }
      50% { transform: translateX(-50%) scale(1.15); opacity: 0.1; }
    }
  `;
  document.head.appendChild(style);
}
