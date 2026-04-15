import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';
import { API_BASE } from '../lib/config.js';

const AGENTS = [
  { id: 'front_desk',      name: 'Desk',    label: 'Front Desk',      colour: '#C76B8A' },
  { id: 'content_creator', name: 'Studio',  label: 'Content',         colour: '#D4943A' },
  { id: 'client_intel',    name: 'Intel',   label: 'Client Intel',    colour: '#7B6BA8' },
  { id: 'business_coach',  name: 'Coach',   label: 'Biz Coach',       colour: '#5BA97B' },
  { id: 'scheduler',       name: 'Sched',   label: 'Scheduler',       colour: '#4A90D9' },
  { id: 'guardian',        name: 'Guard',   label: 'Guardian',        colour: '#C9A96E' },
];

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

// 6 illustrated characters, fully drawn in code. No external image URLs.
// Each has a unique personality prop that matches their role.

// 1. Front Desk — receptionist with headset + mic
function AvatarFrontDesk({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#C76B8A"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="25.2" cy="24.3" r="0.6" fill="#fff"/>
      <circle cx="32.2" cy="24.3" r="0.6" fill="#fff"/>
      <path d="M23.5 29.5 Q28 33.5 32.5 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Headset */}
      <path d="M16.5 24 Q16 11 28 11 Q40 11 39.5 24" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      <rect x="13.5" y="22.5" width="4.5" height="7" rx="2.25" fill="#fff"/>
      <rect x="38" y="22.5" width="4.5" height="7" rx="2.25" fill="#fff"/>
      <path d="M39 27 Q43 31 40.5 34.5" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <circle cx="40.5" cy="35" r="1.8" fill="#fff"/>
      {/* Speech bubble */}
      <rect x="3" y="6" width="14" height="10" rx="3" fill="#fff" opacity="0.85"/>
      <path d="M8 16 L6 20 L12 16" fill="#fff" opacity="0.85"/>
      <circle cx="7" cy="11" r="1" fill="#C76B8A"/>
      <circle cx="10" cy="11" r="1" fill="#C76B8A"/>
      <circle cx="13" cy="11" r="1" fill="#C76B8A"/>
    </svg>
  );
}

// 2. Content Creator — creative character with palette + brush
function AvatarContentCreator({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#D4943A"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Creative eyes — one winking */}
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <path d="M30 24 Q31.5 22 33 24" stroke="#3D2B1A" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <circle cx="25.2" cy="24.3" r="0.65" fill="#fff"/>
      {/* Big grin */}
      <path d="M22 29.5 Q28 35 34 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Artist palette top-right */}
      <ellipse cx="43" cy="12" rx="8" ry="7" fill="#fff" opacity="0.9"/>
      <circle cx="40" cy="10" r="2" fill="#C76B8A"/>
      <circle cx="46" cy="10" r="2" fill="#4A90D9"/>
      <circle cx="43" cy="7" r="2" fill="#5BA97B"/>
      <circle cx="46" cy="15" r="2" fill="#F59E0B"/>
      {/* Brush */}
      <path d="M37 19 L31 25" stroke="#3D2B1A" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="30" cy="26" r="2" fill="#D4943A" opacity="0.8"/>
      {/* Star sparkle top-left */}
      <path d="M9 8 L9.5 11 L12 11 L10 13 L10.5 16 L9 14 L7.5 16 L8 13 L6 11 L8.5 11Z" fill="#fff" opacity="0.8"/>
    </svg>
  );
}

// 3. Client Intel — analyst with magnifying glass + data dots
function AvatarClientIntel({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#7B6BA8"/>
      <circle cx="28" cy="27.5" r="13" fill="#FFD5B0"/>
      {/* Focused/smart eyes */}
      <ellipse cx="24.5" cy="25" rx="2" ry="1.6" fill="#3D2B1A"/>
      <ellipse cx="31.5" cy="25" rx="2" ry="1.6" fill="#3D2B1A"/>
      <circle cx="25" cy="24.5" r="0.6" fill="#fff"/>
      <circle cx="32" cy="24.5" r="0.6" fill="#fff"/>
      {/* Slight knowing smile */}
      <path d="M24.5 29.5 Q28 32.5 31.5 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Magnifying glass */}
      <circle cx="42" cy="12" r="7" fill="none" stroke="#fff" strokeWidth="2.5" opacity="0.9"/>
      <circle cx="42" cy="12" r="4.5" fill="#fff" opacity="0.2"/>
      <line x1="46.5" y1="16.5" x2="50" y2="20" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
      {/* Data dots (clients being analysed) */}
      <circle cx="40" cy="11" r="1.2" fill="#C76B8A" opacity="0.8"/>
      <circle cx="43" cy="10" r="1.2" fill="#5BA97B" opacity="0.8"/>
      <circle cx="43" cy="13.5" r="1.2" fill="#F59E0B" opacity="0.8"/>
      {/* Mini bar chart bottom-left */}
      <rect x="5" y="15" width="3" height="6" rx="1" fill="#fff" opacity="0.6"/>
      <rect x="9" y="12" width="3" height="9" rx="1" fill="#fff" opacity="0.8"/>
      <rect x="13" y="9" width="3" height="12" rx="1" fill="#fff" opacity="0.9"/>
    </svg>
  );
}

// 4. Business Coach — confident advisor with clipboard + upward chart
function AvatarBusinessCoach({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#5BA97B"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Confident eyes */}
      <circle cx="24.5" cy="24.5" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="24.5" r="1.8" fill="#3D2B1A"/>
      <circle cx="25.2" cy="23.8" r="0.6" fill="#fff"/>
      <circle cx="32.2" cy="23.8" r="0.6" fill="#fff"/>
      {/* Authoritative smile */}
      <path d="M23.5 29 Q28 33 32.5 29" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Clipboard top-right */}
      <rect x="35" y="7" width="14" height="17" rx="2.5" fill="#fff" opacity="0.9"/>
      <rect x="39" y="5" width="6" height="4" rx="2" fill="#5BA97B" opacity="0.8"/>
      {/* Rising chart on clipboard */}
      <polyline points="37,20 40,17 43,15 46,11" stroke="#5BA97B" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="46" cy="11" r="1.5" fill="#5BA97B"/>
      {/* Arrow up */}
      <path d="M44 9 L46 11 L48 9" stroke="#5BA97B" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      {/* Lightbulb top-left */}
      <circle cx="10" cy="11" r="5.5" fill="#fff" opacity="0.85"/>
      <path d="M8 14 L12 14" stroke="#F59E0B" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M9 15.5 L11 15.5" stroke="#F59E0B" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M10 5.5 L10 6.5 M6 7.5 L7 8.5 M14 7.5 L13 8.5" stroke="#F59E0B" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

// 5. Scheduler — organised planner with open calendar + clock
function AvatarScheduler({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#4A90D9"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Focused eyes with raised brow (busy!) */}
      <path d="M22 22 Q24.5 20.5 27 22" stroke="#3D2B1A" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      <path d="M29 22 Q31.5 20.5 34 22" stroke="#3D2B1A" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      <ellipse cx="24.5" cy="24.5" rx="2" ry="1.6" fill="#3D2B1A"/>
      <ellipse cx="31.5" cy="24.5" rx="2" ry="1.6" fill="#3D2B1A"/>
      <circle cx="25" cy="24" r="0.6" fill="#fff"/>
      <circle cx="32" cy="24" r="0.6" fill="#fff"/>
      <path d="M24 29 Q28 32 32 29" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Calendar open top-right */}
      <rect x="34" y="6" width="17" height="16" rx="2.5" fill="#fff" opacity="0.9"/>
      <rect x="34" y="6" width="17" height="5" rx="2.5" fill="#4A90D9" opacity="0.7"/>
      <rect x="37" y="4" width="2" height="4" rx="1" fill="#fff"/>
      <rect x="46" y="4" width="2" height="4" rx="1" fill="#fff"/>
      {/* Calendar grid */}
      <circle cx="37" cy="15" r="1" fill="#4A90D9"/>
      <circle cx="40.5" cy="15" r="1" fill="#4A90D9"/>
      <circle cx="44" cy="15" r="1.2" fill="#C76B8A"/>
      <circle cx="47.5" cy="15" r="1" fill="#4A90D9"/>
      <circle cx="37" cy="19" r="1" fill="#4A90D9"/>
      <circle cx="40.5" cy="19" r="1" fill="#4A90D9"/>
      {/* Clock bottom-left */}
      <circle cx="10" cy="14" r="7" fill="#fff" opacity="0.85"/>
      <circle cx="10" cy="14" r="5.5" fill="none" stroke="#4A90D9" strokeWidth="1"/>
      <line x1="10" y1="14" x2="10" y2="10" stroke="#3D2B1A" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="10" y1="14" x2="13" y2="15.5" stroke="#C76B8A" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="10" cy="14" r="1" fill="#3D2B1A"/>
    </svg>
  );
}

// 6. Guardian — protector with shield + check mark + star
function AvatarGuardian({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#C9A96E"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Warm, trustworthy eyes */}
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="25.2" cy="24.2" r="0.6" fill="#fff"/>
      <circle cx="32.2" cy="24.2" r="0.6" fill="#fff"/>
      {/* Warm reassuring smile */}
      <path d="M23 29 Q28 33.5 33 29" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Shield top-right */}
      <path d="M42 6 L50 9 L50 16 Q50 22 42 25 Q34 22 34 16 L34 9 Z" fill="#fff" opacity="0.9"/>
      <path d="M42 8 L48 10.5 L48 16 Q48 21 42 23.5 Q36 21 36 16 L36 10.5 Z" fill="#C9A96E" opacity="0.3"/>
      {/* Check mark on shield */}
      <path d="M38 16 L41 19 L46 13" stroke="#5BA97B" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Stars floating left — reputation */}
      <path d="M9 10 L10 13 L13 13 L10.5 15 L11.5 18 L9 16 L6.5 18 L7.5 15 L5 13 L8 13Z" fill="#fff" opacity="0.9"/>
      <path d="M6 5 L6.5 6.5 L8 6.5 L7 7.5 L7.5 9 L6 8 L4.5 9 L5 7.5 L4 6.5 L5.5 6.5Z" fill="#fff" opacity="0.7"/>
    </svg>
  );
}

const AVATAR_COMPONENTS = {
  front_desk:      AvatarFrontDesk,
  content_creator: AvatarContentCreator,
  client_intel:    AvatarClientIntel,
  business_coach:  AvatarBusinessCoach,
  scheduler:       AvatarScheduler,
  guardian:        AvatarGuardian,
};

// Unified: replaces separate AgentStrip + SuperpowersSection.
// 2-col grid of 6 agents, each with live counter + latest action + Ask Florrie.

const AGENT_MAP = [
  { id: 'front_desk',      name: 'Front Desk',     role: 'Handles client messages',  colour: '#C76B8A', path: '/inbox',          counterKey: 'inbox'      },
  { id: 'content_creator', name: 'Content Studio', role: 'Writes captions & posts',  colour: '#D4943A', path: '/content',         counterKey: 'content'    },
  { id: 'client_intel',    name: 'Client Intel',   role: 'Knows your clients inside out', colour: '#7B6BA8', path: '/client-intel',    counterKey: 'churn'      },
  { id: 'business_coach',  name: 'Biz Coach',      role: 'Reads your numbers',       colour: '#5BA97B', path: '/ai-insights',     counterKey: 'insights'   },
  { id: 'scheduler',       name: 'Scheduler',      role: 'Optimises your diary',     colour: '#4A90D9', path: '/smart-schedule',  counterKey: null         },
  { id: 'guardian',        name: 'Guardian',       role: 'Keeps you compliant',      colour: '#C9A96E', path: '/compliance',      counterKey: 'compliance' },
];

function AgentTeamSection({ beautician, onNav }) {
  const [agentData,     setAgentData]     = useState({});
  const [counts,        setCounts]        = useState({});
  const [tickerIdx,     setTickerIdx]     = useState(0);
  const [tickerVisible, setTickerVisible] = useState(true);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 60_000);
    return () => clearInterval(iv);
  }, []);

  async function fetchAll() {
    const token = getToken();
    const h = token ? { Authorization: `Bearer ${token}` } : {};
    const safe = async (url) => {
      try { const r = await fetch(url, { headers: h }); return r.ok ? r.json() : null; }
      catch { return null; }
    };
    const [status, countsData] = await Promise.all([
      safe(`${API_BASE}/api/agents/status`),
      safe(`${API_BASE}/api/agents/counts`),
    ]);

    // Parse agent status
    const mapped = {};
    if (status?.agents) status.agents.forEach(a => { mapped[a.id] = a; });
    if (status?.countByEmployee) {
      Object.entries(status.countByEmployee).forEach(([id, val]) => {
        if (!mapped[id]) mapped[id] = {};
        mapped[id].actionsToday = val?.today || 0;
      });
    }
    if (status?.latestByEmployee) {
      Object.entries(status.latestByEmployee).forEach(([id, val]) => {
        if (!mapped[id]) mapped[id] = {};
        mapped[id].latest   = val?.summary || val?.action_type || null;
        mapped[id].isActive = true;
      });
    }
    setAgentData(mapped);

    // Badge counts from single endpoint
    setCounts({
      inbox:      countsData?.inbox      || null,
      content:    countsData?.content    || null,
      churn:      countsData?.churn      || null,
      insights:   countsData?.insights   || null,
      compliance: countsData?.compliance || null,
    });
  }

  const activeAgents = AGENT_MAP.filter(a => {
    const d = agentData[a.id] || {};
    return d.isActive || (d.actionsToday || 0) > 0;
  });

  useEffect(() => {
    if (activeAgents.length < 2) return;
    const cycle = setInterval(() => {
      setTickerVisible(false);
      setTimeout(() => { setTickerIdx(i => (i + 1) % activeAgents.length); setTickerVisible(true); }, 350);
    }, 3500);
    return () => clearInterval(cycle);
  }, [activeAgents.length]);

  const tickerAgent  = activeAgents[tickerIdx % Math.max(1, activeAgents.length)];
  const activeCount  = activeAgents.length;
  const bzInitials   = beautician ? `${beautician.first_name?.[0] || ''}${beautician.last_name?.[0] || ''}`.toUpperCase() : '?';
  const bzPhoto      = beautician?.avatar_url || beautician?.photo_url || null;

  return (
    <div style={AT.wrap}>
      {/* Header row: title + active badge */}
      <div style={AT.header}>
        <span style={AT.title}>Your AI team</span>
        {activeCount > 0 && (
          <span style={AT.activeBadge}>{activeCount} active</span>
        )}
      </div>

      {/* Compact horizontal avatar strip */}
      <div style={AT.strip}>
        {AGENT_MAP.map(agent => {
          const d        = agentData[agent.id] || {};
          const isActive = d.isActive || (d.actionsToday || 0) > 0;
          const count    = agent.counterKey ? counts[agent.counterKey] : null;
          const AvatarComp = AVATAR_COMPONENTS[agent.id];

          return (
            <button
              key={agent.id}
              onClick={() => onNav(agent.path, agent.name, 'smart_toy')}
              style={AT.agentBtn}
            >
              <div style={{ position: 'relative', width: 40, height: 40 }}>
                {isActive && (
                  <div style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: `2px solid ${agent.colour}`, opacity: 0.5, animation: 'agentPulse 2.2s ease infinite' }} />
                )}
                {AvatarComp && <AvatarComp size={40} />}
                {count != null && count > 0 && (
                  <span style={{ ...AT.countBadge, background: agent.colour }}>
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </div>
              <span style={AT.agentLabel}>{agent.name.split(' ')[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Ticker — or day-1 empty state */}
      {tickerAgent ? (
        <div style={AT.ticker}>
          <span className="material-symbols-outlined" style={{ fontSize: 12, color: '#92405e', flexShrink: 0 }}>auto_awesome</span>
          <span style={{ ...AT.tickerText, opacity: tickerVisible ? 1 : 0, transition: 'opacity 0.3s ease' }}>
            {AGENT_MAP.find(a => a.id === tickerAgent.id)?.name} → {agentData[tickerAgent.id]?.latest || 'Working…'}
          </span>
        </div>
      ) : (
        <div style={AT.emptyState}>
          <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#C76B8A', flexShrink: 0 }}>schedule</span>
          <span style={AT.emptyText}>
            Florrie kicks in after your first booking — we'll handle the follow-ups
          </span>
        </div>
      )}

      {/* Ask Florrie pill */}
      <button onClick={() => onNav('/voice', 'Voice', 'mic')} style={AT.askPill}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#92405e' }}>mic</span>
        <span style={AT.askText}>Ask Florrie anything…</span>
        <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#C5B8B2' }}>chevron_right</span>
      </button>
    </div>
  );
}

const AT = {
  wrap: {
    background: 'linear-gradient(150deg, #fff5f8 0%, #fff 65%)',
    borderRadius: 20,
    border: '1px solid rgba(199,107,138,0.13)',
    padding: '12px 14px 12px',
    marginBottom: 16,
    boxShadow: '0 2px 20px rgba(199,107,138,0.07)',
  },
  header: {
    display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 10,
  },
  title: {
    fontSize: 13, fontWeight: 700, color: '#92405e',
    fontFamily: "'Noto Serif', Georgia, serif", fontStyle: 'italic',
  },
  activeBadge: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
    color: '#92405e', background: '#ffd9e2', padding: '2px 8px', borderRadius: 20,
  },
  strip: {
    display: 'flex', justifyContent: 'space-between',
    gap: 4, marginBottom: 10,
  },
  agentBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    background: 'none', border: 'none', cursor: 'pointer',
    fontFamily: 'inherit', padding: '4px 2px',
    WebkitTapHighlightColor: 'transparent',
    flex: 1, minWidth: 0,
  },
  agentLabel: {
    fontSize: 9, fontWeight: 600, color: '#534247',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    maxWidth: '100%',
  },
  countBadge: {
    position: 'absolute', top: -4, right: -4,
    fontSize: 9, fontWeight: 700, color: '#fff',
    padding: '1px 5px', borderRadius: 8,
    minWidth: 14, textAlign: 'center', lineHeight: '14px',
  },
  ticker: {
    display: 'flex', alignItems: 'center', gap: 7,
    background: 'rgba(199,107,138,0.06)', borderRadius: 10,
    padding: '7px 10px', marginBottom: 9,
  },
  tickerText: {
    fontSize: 11, color: '#534247', flex: 1,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  emptyState: {
    display: 'flex', alignItems: 'center', gap: 7,
    background: 'rgba(199,107,138,0.04)', borderRadius: 10,
    padding: '7px 10px', marginBottom: 9,
    border: '1px dashed rgba(199,107,138,0.2)',
  },
  emptyText: {
    fontSize: 11, color: '#9B8A8E', flex: 1, lineHeight: 1.4,
  },
  askPill: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
    background: '#fff', border: '1.5px solid rgba(199,107,138,0.18)',
    borderRadius: 13, padding: '10px 14px',
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    boxSizing: 'border-box',
  },
  askText: { flex: 1, fontSize: 13, color: '#C5B8B2', textAlign: 'left' },
};

function TodayStrip({ beautician }) {
  const [todayData, setTodayData] = useState(null);

  useEffect(() => {
    if (!beautician) return;
    fetchToday();
  }, [beautician?.id]);

  async function fetchToday() {
    const token = getToken();
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };

    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    try {
      const res = await fetch(
        `${API_BASE}/api/appointments?from=${start}&to=${end}&per_page=100`,
        { headers: h }
      );
      if (!res.ok) return;
      const json = await res.json();
      const appts = json.data || [];

      const confirmed = appts.filter(a => ['confirmed', 'booked'].includes(a.status)).length;
      const pending   = appts.filter(a => ['pending', 'requested'].includes(a.status)).length;

      // Next upcoming appointment
      const upcoming = appts
        .filter(a => new Date(a.starts_at) > now)
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
      const next = upcoming[0];
      const nextTime = next
        ? new Date(next.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : null;

      setTodayData({ confirmed, pending, nextTime, total: appts.length });
    } catch {}
  }

  const today   = new Date();
  const dayName = today.toLocaleDateString('en-GB', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  return (
    <div style={TS.wrap}>
      <div style={TS.dateRow}>
        <span style={TS.dayName}>{dayName}</span>
        <span style={TS.dateStr}>{dateStr}</span>
      </div>
      {todayData !== null && (
        <div style={TS.statsRow}>
          {todayData.total === 0 ? (
            <span style={TS.empty}>No bookings today — enjoy the breathing room</span>
          ) : (
            <>
              <div style={TS.stat}>
                <span style={TS.statNum}>{todayData.confirmed}</span>
                <span style={TS.statLabel}>confirmed</span>
              </div>
              {todayData.pending > 0 && (
                <div style={TS.stat}>
                  <span style={{ ...TS.statNum, color: '#D4943A' }}>{todayData.pending}</span>
                  <span style={TS.statLabel}>pending</span>
                </div>
              )}
              {todayData.nextTime && (
                <div style={TS.stat}>
                  <span style={TS.statNum}>{todayData.nextTime}</span>
                  <span style={TS.statLabel}>next appt</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const TS = {
  wrap: {
    background: 'linear-gradient(135deg, #C76B8A 0%, #9b4d6e 100%)',
    borderRadius: 20,
    padding: '14px 16px',
    marginBottom: 14,
    boxShadow: '0 4px 16px rgba(199,107,138,0.25)',
  },
  dateRow: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 },
  dayName: { fontSize: 18, fontWeight: 700, color: '#fff', fontFamily: "'Noto Serif', Georgia, serif", fontStyle: 'italic' },
  dateStr: { fontSize: 12, color: 'rgba(255,255,255,0.7)' },
  statsRow: { display: 'flex', alignItems: 'center', gap: 20 },
  stat: { display: 'flex', flexDirection: 'column', gap: 1 },
  statNum:   { fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1 },
  statLabel: { fontSize: 10, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  empty:     { fontSize: 12, color: 'rgba(255,255,255,0.65)' },
};

const CATEGORIES = [
  {
    id: 'daily',
    label: 'Your Day',
    matIcon: 'wb_sunny',
    items: [
      { path: '/calendar',       label: "Today's List",    matIcon: 'event_note',           desc: 'Appointments & schedule'       },
      { path: '/smart-schedule', label: 'Smart Schedule',  matIcon: 'schedule_send',        desc: 'AI-optimised slots',            gate: 'smart_schedule' },
      { path: '/waitlist-pro',   label: 'Waitlist',        matIcon: 'history',              desc: 'Manage waiting clients'        },
      { path: '/checklist',      label: 'Checklist',       matIcon: 'checklist',            desc: 'Daily opening & closing'       },
      { path: '/end-of-day',     label: 'End of Day',      matIcon: 'nightlight',           desc: 'Cash-up and close'             },
      { path: '/notifications',  label: 'Notifications',   matIcon: 'notifications',        desc: 'Alerts & reminders'            },
      { path: '/hours',          label: 'Hours & Time Off', matIcon: 'beach_access',        desc: 'Exceptions & closures'         },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    matIcon: 'people',
    items: [
      { path: '/clients',        label: 'Directory',       matIcon: 'people',               desc: 'All client profiles'           },
      { path: '/churn',          label: 'Churn Risk',      matIcon: 'person_off',           desc: 'At-risk clients',               gate: 'churn_prevention' },
      { path: '/segments',       label: 'Segments',        matIcon: 'workspaces',           desc: 'Smart RFM grouping',            gate: 'client_segments' },
      { path: '/loyalty',        label: 'Loyalty',         matIcon: 'loyalty',              desc: 'Points & rewards',              gate: 'loyalty' },
      { path: '/reviews',        label: 'Feedback',        matIcon: 'reviews',              desc: 'Reviews & responses'           },
      { path: '/memberships',    label: 'Memberships',     matIcon: 'card_membership',      desc: 'Recurring packages'            },
      { path: '/tags',           label: 'Tags & Groups',   matIcon: 'label',                desc: 'Organise & segment'            },
      { path: '/photo-consent',  label: 'Photo Consent',   matIcon: 'photo_camera',         desc: 'Before/after consent'          },
      { path: '/import',         label: 'Import',          matIcon: 'upload',               desc: 'CSV & bulk import'             },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments',
    matIcon: 'spa',
    items: [
      { path: '/treatments',     label: 'Treatments',      matIcon: 'spa',                  desc: 'Manage services'               },
      { path: '/aftercare',      label: 'Aftercare',       matIcon: 'self_care',            desc: 'Post-treatment messages',       gate: 'aftercare' },
      { path: '/packages',       label: 'Courses',         matIcon: 'school',               desc: 'Training & masterclasses'      },
      { path: '/addons',         label: 'Add-ons',         matIcon: 'add_circle',           desc: 'Bolt-on extras'                },
      { path: '/price-list',     label: 'Price List',      matIcon: 'format_list_bulleted', desc: 'Public pricing page'           },
      { path: '/notes',          label: 'Appt Notes',      matIcon: 'sticky_note_2',        desc: 'Notes per appointment'         },
    ],
  },
  {
    id: 'compliance',
    label: 'Compliance',
    matIcon: 'verified_user',
    items: [
      { path: '/compliance',          label: 'Compliance',   matIcon: 'verified_user', desc: 'Patch tests & consent forms' },
      { path: '/patch-tests',         label: 'Patch Tests',  matIcon: 'vaccines',      desc: 'UK compliance tracking'      },
      { path: '/consultation-forms',  label: 'Form Builder', matIcon: 'assignment',    desc: 'Consent & intake forms'      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    matIcon: 'payments',
    items: [
      { path: '/money',         label: 'Money Tracker',    matIcon: 'account_balance_wallet', desc: 'Revenue dashboard'         },
      { path: '/ai-insights',   label: 'AI Insights',      matIcon: 'psychology',             desc: 'AI business analysis',      gate: 'ai_insights' },
      { path: '/analytics',     label: 'Analytics',        matIcon: 'analytics',              desc: 'Performance & reports'     },
      { path: '/expenses',      label: 'Expenses',         matIcon: 'receipt_long',           desc: 'Track outgoings'           },
      { path: '/deposits',      label: 'Deposits',         matIcon: 'savings',                desc: 'Held payments'             },
      { path: '/goals',         label: 'Goals',            matIcon: 'flag',                   desc: 'Revenue targets'           },
      { path: '/vouchers',      label: 'Vouchers',         matIcon: 'card_giftcard',          desc: 'Gift vouchers'             },
      { path: '/promos',        label: 'Promo Codes',      matIcon: 'local_offer',            desc: 'Discount codes'            },
      { path: '/inventory',     label: 'Inventory',        matIcon: 'category',               desc: 'Product stock'             },
      { path: '/cancellations', label: 'Cancellations',    matIcon: 'event_busy',             desc: 'No-shows & late cancels'   },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    matIcon: 'campaign',
    items: [
      { path: '/content',     label: 'Content Autopilot', matIcon: 'auto_fix_high',  desc: 'AI-written captions',       gate: 'content_autopilot' },
      { path: '/campaigns',   label: 'Campaigns',         matIcon: 'mail',           desc: 'Email & SMS blasts',        gate: 'campaigns' },
      { path: '/rebook',      label: 'Rebook',            matIcon: 'replay',         desc: 'Bring clients back'        },
      { path: '/referrals',   label: 'Referrals',         matIcon: 'group_add',      desc: 'Word-of-mouth tracking'    },
      { path: '/automations', label: 'Automations',       matIcon: 'bolt',           desc: 'If-this-then-that rules'   },
      { path: '/templates',   label: 'Templates',         matIcon: 'description',    desc: 'Reusable messages'         },
      { path: '/whatsapp',    label: 'WhatsApp',          matIcon: 'smartphone',     desc: 'Business messaging',        gate: 'whatsapp' },
      { path: '/portfolio',   label: 'Portfolio',         matIcon: 'photo_library',  desc: 'Showcase your work'        },
    ],
  },
  {
    id: 'settings',
    label: 'Settings & Team',
    matIcon: 'settings',
    items: [
      { path: '/settings',          label: 'Settings',        matIcon: 'settings',           desc: 'Account preferences'          },
      { path: '/business',          label: 'Business',        matIcon: 'storefront',         desc: 'Name, logo & details'         },
      { path: '/integrations',      label: 'Integrations',    matIcon: 'extension',          desc: 'Connected apps'               },
      { path: '/pricing',           label: 'Plans',           matIcon: 'workspace_premium',  desc: 'Subscription & billing'       },
      { path: '/policies',          label: 'Policies',        matIcon: 'policy',             desc: 'Cancellation & terms'         },
      { path: '/portal',            label: 'Booking Page',    matIcon: 'open_in_browser',    desc: 'Public booking & magic links' },
      { path: '/team',              label: 'Team',            matIcon: 'group',              desc: 'Staff profiles',               gate: 'team_management' },
      { path: '/rota',              label: 'Staff Rota',      matIcon: 'calendar_view_week', desc: 'Weekly schedule',              gate: 'staff_rota' },
      { path: '/staff-performance', label: 'Performance',     matIcon: 'trending_up',        desc: 'Team analytics',               gate: 'staff_performance' },
      { path: '/locations',         label: 'Multi-Location',  matIcon: 'location_city',      desc: 'Branch management',            gate: 'multi_location' },
    ],
  },
];

const RECENT_KEY = 'florrie_recent_pages';
const RECENT_MAX = 6;

function getRecents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function recordVisit(path, label, matIcon) {
  try {
    const recents = getRecents().filter(r => r.path !== path);
    recents.unshift({ path, label, matIcon });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_MAX)));
  } catch {}
}

function MIcon({ name, size = 24, color, style }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, color, ...style }}
    >
      {name}
    </span>
  );
}

export default function Hub() {
  const [search, setSearch] = useState('');
  // First two categories expanded by default (Your Day + Clients)
  const [expandedCats, setExpandedCats] = useState(new Set(['daily', 'clients']));
  const [recents, setRecents] = useState(getRecents);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'trial';

  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i =>
        i.label.toLowerCase().includes(q) ||
        (i.desc || '').toLowerCase().includes(q) ||
        cat.label.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.items.length > 0);
  }, [search]);

  function toggleCat(id) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleNav(path, label, matIcon) {
    recordVisit(path, label, matIcon);
    setRecents(getRecents());
    navigate(path);
  }

  return (
    <div style={S.page}>
      {/* ── Today strip ── */}
      <TodayStrip beautician={beautician} />

      {/* ── Agent team section ── */}
      <AgentTeamSection beautician={beautician} onNav={handleNav} />

      {/* ── Search ── */}
      <div style={S.searchWrap}>
        <MIcon name="search" size={18} style={S.searchIcon} />
        <input
          type="text"
          placeholder="Search features…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={S.searchInput}
        />
        {search && (
          <button onClick={() => setSearch('')} style={S.searchClear}>
            <MIcon name="close" size={14} />
          </button>
        )}
      </div>

      {/* ── Recents row ── */}
      {!search && recents.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={S.sectionLabel}>Recently visited</div>
          <div style={S.recentRow}>
            {recents.map(r => (
              <button
                key={r.path}
                onClick={() => handleNav(r.path, r.label, r.matIcon)}
                style={S.recentChip}
              >
                <MIcon name={r.matIcon || 'star'} size={14} color="#92405e" />
                <span style={S.recentLabel}>{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Search results ── */}
      {search && (
        <div style={{ marginBottom: 8 }}>
          {filtered.length === 0 ? (
            <div style={S.emptySearch}>
              <MIcon name="search_off" size={36} style={{ color: '#d8c1c6', display: 'block', marginBottom: 8 }} />
              <p style={{ margin: 0, color: '#867277', fontSize: 14 }}>No results for "{search}"</p>
            </div>
          ) : (
            filtered.map(cat => (
              <div key={cat.id} style={{ marginBottom: 16 }}>
                <div style={S.sectionLabel}>{cat.label}</div>
                <div style={S.itemGrid}>
                  {cat.items.map(item => (
                    <ItemCard
                      key={item.path}
                      item={item}
                      locked={item.gate && !hasFeature(plan, item.gate)}
                      isActive={location.pathname === item.path}
                      plan={plan}
                      onNav={() => handleNav(item.path, item.label, item.matIcon)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Category accordions ── */}
      {!search && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CATEGORIES.map(cat => {
            const isExpanded = expandedCats.has(cat.id);
            // When collapsed, just show the header row
            // When expanded, show 2-col grid of square item cards

            return (
              <div key={cat.id} style={S.catCard}>
                {/* Header */}
                <button
                  onClick={() => toggleCat(cat.id)}
                  style={S.catHeader}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <MIcon name={cat.matIcon} size={20} color="rgba(146,64,94,0.65)" />
                    <span style={S.catLabel}>{cat.label}</span>
                  </div>
                  <MIcon
                    name={isExpanded ? 'expand_less' : 'expand_more'}
                    size={20}
                    color="#B5AFA8"
                  />
                </button>

                {/* Expanded grid */}
                {isExpanded && (
                  <div style={S.expandedBody}>
                    <div style={S.itemGrid}>
                      {cat.items.map(item => (
                        <ItemCard
                          key={item.path}
                          item={item}
                          locked={item.gate && !hasFeature(plan, item.gate)}
                          isActive={location.pathname === item.path}
                          plan={plan}
                          onNav={() => handleNav(item.path, item.label, item.matIcon)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemCard({ item, locked, isActive, plan, onNav }) {
  return (
    <button
      onClick={onNav}
      style={{
        ...S.item,
        ...(isActive ? S.itemActive : {}),
        ...(locked ? { opacity: 0.55 } : {}),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }}>
        <MIcon name={item.matIcon} size={22} color={isActive ? '#92405e' : '#92405e'} style={{ opacity: isActive ? 1 : 0.75 }} />
        {locked && (
          <span style={S.lockBadge}>
            {(getRequiredPlan(item.gate) || 'PRO').toUpperCase()}
          </span>
        )}
      </div>
      <span style={S.itemLabel}>{item.label}</span>
      {item.desc && <span style={S.itemDesc}>{item.desc}</span>}
    </button>
  );
}

const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    padding: '16px 16px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },

  searchWrap: { position: 'relative', marginBottom: 20 },
  searchIcon: {
    position: 'absolute', left: 14, top: '50%',
    transform: 'translateY(-50%)', color: '#B5AFA8', pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '11px 36px 11px 42px',
    borderRadius: 99,
    border: 'none',
    background: '#fff',
    fontSize: 14,
    fontFamily: 'inherit',
    color: '#1d1b19',
    outline: 'none',
    boxSizing: 'border-box',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  searchClear: {
    position: 'absolute', right: 10, top: '50%',
    transform: 'translateY(-50%)',
    background: '#f3ede9', border: 'none', borderRadius: 8,
    width: 22, height: 22, color: '#867277', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  sectionLabel: {
    fontSize: 10, fontWeight: 700, color: '#B5AFA8',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: 8,
  },
  recentRow: {
    display: 'flex', gap: 8, overflowX: 'auto',
    scrollbarWidth: 'none', paddingBottom: 2,
  },
  recentChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 13px', borderRadius: 99,
    border: '1px solid rgba(146,64,94,0.1)', background: '#fff',
    cursor: 'pointer', fontFamily: 'inherit',
    flexShrink: 0, whiteSpace: 'nowrap',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  recentLabel: { fontSize: 12, fontWeight: 600, color: '#534247' },

  emptySearch: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '40px 16px', textAlign: 'center',
  },

  // Category cards
  catCard: {
    background: '#fff',
    borderRadius: 20,
    border: '1px solid rgba(146,64,94,0.07)',
    overflow: 'hidden',
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
  },
  catHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', background: 'none', border: 'none',
    cursor: 'pointer', padding: '14px 16px',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catLabel: {
    fontSize: 14, fontWeight: 700, color: '#1d1b19',
  },
  expandedBody: {
    background: '#f8f2ef',
    padding: '12px 12px 14px',
    borderTop: '1px solid rgba(146,64,94,0.06)',
  },

  // Item grid — 2 columns of square cards
  itemGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '14px 12px 12px',
    borderRadius: 14,
    border: 'none',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  },
  itemActive: {
    background: '#ffd9e2',
    boxShadow: 'inset 0 0 0 1.5px #92405e',
  },
  itemLabel: {
    fontSize: 11, fontWeight: 700, color: '#1d1b19', lineHeight: 1.3, marginBottom: 2,
  },
  itemDesc: {
    fontSize: 9.5, color: '#B5AFA8', lineHeight: 1.35, fontWeight: 400,
  },
  lockBadge: {
    fontSize: 8, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 5px', borderRadius: 5,
    letterSpacing: '0.05em',
  },
};

// Inject keyframes
if (typeof document !== 'undefined' && !document.getElementById('hub-keyframes')) {
  const s = document.createElement('style');
  s.id = 'hub-keyframes';
  s.textContent = `
    @keyframes agentPulse {
      0%, 100% { transform: scale(1);   opacity: 0.3; }
      50%       { transform: scale(1.2); opacity: 0.12; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}
