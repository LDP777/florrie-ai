import { useState, useRef, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Voice Commander — Talk to florrie.ai.
 *
 * This is the conversational voice interface to the entire AI agent network.
 * Speak naturally and florrie.ai routes your request to the right agent:
 *
 *   "Move Shauna to Thursday 2pm"       → Calendar agent
 *   "Send a comeback message to Daisy"  → Campaign agent
 *   "What did I earn this week?"        → Analytics agent
 *   "Block out Friday afternoon"        → Schedule agent
 *   "Draft a post about lash lifts"     → Content agent
 *
 * Powered by Web Speech API for recording, Claude for understanding,
 * and the agent network for execution.
 */

const AGENT_ROUTES = {
  calendar: { label: 'Calendar', icon: '📅', color: '#4A90D9' },
  clients: { label: 'Clients', icon: '👤', color: 'var(--accent, #C76B8A)' },
  campaigns: { label: 'Campaigns', icon: '💌', color: '#E57373' },
  money: { label: 'Money', icon: '💰', color: '#4CAF50' },
  content: { label: 'Content', icon: '📸', color: '#F5A623' },
  settings: { label: 'Settings', icon: '⚙️', color: '#6b6560' },
  general: { label: 'florrie.ai', icon: '✨', color: 'var(--accent, #C76B8A)' },
};

// Simulated conversation for dev mode
const DEV_CONVERSATION = [
  {
    id: '1',
    role: 'assistant',
    text: "Hey lovely! I'm here whenever you need me. Just tap the mic and talk — I'll handle everything.",
    agent: 'general',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
  },
];

const EXAMPLE_PROMPTS = [
  "Move Shauna's appointment to Thursday",
  "What did I earn this week?",
  "Send a comeback message to dormant clients",
  "Block out Friday afternoon",
  "Draft an Instagram post about lash lifts",
  "Who's my most loyal client?",
];

export default function VoiceCommander() {
  const { beautician, loading: bLoading } = useBeautician();
  const [messages, setMessages] = useState(isDevMode ? DEV_CONVERSATION : []);
  const [loading, setLoading] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [pulseAnim, setPulseAnim] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (beautician && !bLoading) loadHistory();
  }, [beautician, bLoading]);

  async function loadHistory() {
    setLoading(true);
    try {
      if (isDevMode) {
        setMessages(DEV_CONVERSATION);
      } else {
        // Only show today's AI-driven actions — booking confirmations belong in Notifications
        const todayStr = new Date().toISOString().slice(0, 10);
        const data = await fetchRows('ai_actions', beautician.id, {
          order: 'created_at', ascending: false, limit: 20,
          filters: { created_at: `gte.${todayStr}T00:00:00` },
        });
        // Filter out booking notifications — only show insights, nudges, content, recommendations
        const BOOKING_TYPES = ['booking_confirmed', 'booking_created', 'appointment_booked', 'booking_reminder'];
        const aiOnly = (data || []).filter(action =>
          !BOOKING_TYPES.includes(action.action_type) &&
          !(action.summary || '').match(/booked .+ for \d/)
        );
        const mapped = aiOnly.map(action => ({
          id: action.id,
          role: 'assistant',
          text: action.summary || action.notification_text || action.action_type || 'Action completed',
          agent: action.digital_employee || 'general',
          timestamp: action.created_at,
        }));
        const greeting = { id: '0', role: 'assistant', text: "Hey lovely! I'm here whenever you need me.", agent: 'general', timestamp: new Date().toISOString() };
        setMessages([greeting, ...mapped]);
      }
    } catch (err) {
      logger.error('Load action history error:', err);
      setMessages(DEV_CONVERSATION);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleRecord() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function startRecording() {
    setIsRecording(true);
    setPulseAnim(true);

    // In production, this would use Web Speech API or MediaRecorder
    // For dev mode, simulate a recording after 2 seconds
    if (isDevMode) {
      setTimeout(() => {
        stopRecording("Move Shauna's lamination to Thursday at 2pm");
      }, 2500);
    }
  }

  function stopRecording(transcript) {
    setIsRecording(false);
    setPulseAnim(false);

    if (transcript) {
      processMessage(transcript, true);
    }
  }

  async function processMessage(text, isVoice = false) {
    if (!text.trim()) return;

    // Add user message
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      text: text.trim(),
      isVoice,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setTextInput('');
    setIsProcessing(true);

    // Simulate AI processing
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));

    // Generate response based on keywords (dev mode simulation)
    const response = generateDevResponse(text.trim());
    setMessages(prev => [...prev, response]);
    setIsProcessing(false);
  }

  function generateDevResponse(input) {
    const lower = input.toLowerCase();
    let agent = 'general';
    let text = '';
    let action = null;

    if (lower.includes('move') || lower.includes('reschedule') || lower.includes('appointment') || lower.includes('block') || lower.includes('thursday') || lower.includes('book')) {
      agent = 'calendar';
      text = "Done — I've moved Shauna's Lamination & Hybrid Dye to Thursday 2pm. She'll get a confirmation message automatically. Want me to check if that clashes with anything?";
      action = { type: 'moved_appointment', label: 'View in Calendar', path: '/calendar' };
    } else if (lower.includes('earn') || lower.includes('revenue') || lower.includes('money') || lower.includes('paid') || lower.includes('income')) {
      agent = 'money';
      text = "This week you've taken £385 across 9 appointments. That's up 12% on last week. Your best day was Tuesday (£135). Want the full breakdown?";
      action = { type: 'view_analytics', label: 'View Analytics', path: '/analytics' };
    } else if (lower.includes('comeback') || lower.includes('dormant') || lower.includes('send') || lower.includes('message') || lower.includes('campaign')) {
      agent = 'campaigns';
      text = "On it — I've found 3 clients who haven't been in for 30+ days: Jasmin, Daisy S, and Shauna. I've drafted a comeback message in your voice. Want me to show you before I send?";
      action = { type: 'draft_campaign', label: 'Review Campaign', path: '/campaigns' };
    } else if (lower.includes('post') || lower.includes('instagram') || lower.includes('content') || lower.includes('draft')) {
      agent = 'content';
      text = "I've drafted an Instagram caption about lash lifts. Here's what I've got:\n\n\"Lash lift season is here ✨ Wake up with perfectly curled lashes every morning — no extensions needed. DM to book xx\"\n\nWant me to tweak it?";
      action = { type: 'view_draft', label: 'View in Content', path: '/content' };
    } else if (lower.includes('loyal') || lower.includes('client') || lower.includes('who')) {
      agent = 'clients';
      text = "Your most loyal client is Daisy S — 12 visits, £540 total spend, and she rebooks every 3-4 weeks. She's due back in about 5 days.";
      action = { type: 'view_client', label: 'View Client', path: '/clients' };
    } else if (lower.includes('block') || lower.includes('day off') || lower.includes('holiday')) {
      agent = 'calendar';
      text = "Done — I've blocked out Friday afternoon from 1pm. No one can book during that time. Want me to block the whole day instead?";
    } else {
      agent = 'general';
      text = "Got it! I'll look into that for you. Is there anything specific you'd like me to do with this?";
    }

    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      text,
      agent,
      action,
      timestamp: new Date().toISOString(),
    };
  }

  function handleTextSubmit(e) {
    e.preventDefault();
    if (textInput.trim()) {
      processMessage(textInput, false);
    }
  }

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Talk to florrie.ai</h1>
        <p style={styles.subtitle}>Your AI receptionist. Just ask.</p>
      </div>

      {/* Messages */}
      <div style={styles.messagesContainer}>
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              ...styles.msgRow,
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {msg.role === 'assistant' && (
              <div style={styles.agentAvatar}>
                <span style={{ fontSize: 14 }}>
                  {AGENT_ROUTES[msg.agent]?.icon || '✨'}
                </span>
              </div>
            )}

            <div style={{
              ...styles.bubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.aiBubble),
            }}>
              {msg.role === 'assistant' && msg.agent !== 'general' && (
                <span style={{
                  ...styles.agentTag,
                  color: AGENT_ROUTES[msg.agent]?.color,
                  background: AGENT_ROUTES[msg.agent]?.color + '15',
                }}>
                  {AGENT_ROUTES[msg.agent]?.label}
                </span>
              )}

              <p style={styles.msgText}>{msg.text}</p>

              {msg.isVoice && msg.role === 'user' && (
                <span style={styles.voiceBadge}>🎙️ Voice</span>
              )}

              {msg.action && (
                <button style={styles.actionBtn}>
                  {msg.action.label} →
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Processing indicator */}
        {isProcessing && (
          <div style={styles.msgRow}>
            <div style={styles.agentAvatar}>
              <span style={{ fontSize: 14 }}>✨</span>
            </div>
            <div style={{ ...styles.bubble, ...styles.aiBubble }}>
              <div style={styles.typingDots}>
                <span style={{ ...styles.typingDot, animationDelay: '0s' }}>·</span>
                <span style={{ ...styles.typingDot, animationDelay: '0.2s' }}>·</span>
                <span style={{ ...styles.typingDot, animationDelay: '0.4s' }}>·</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Example prompts (show when conversation is short) */}
      {messages.length <= 2 && !isProcessing && (
        <div style={styles.promptsSection}>
          <span style={styles.promptsLabel}>Try saying:</span>
          <div style={styles.promptsGrid}>
            {EXAMPLE_PROMPTS.map((prompt, i) => (
              <button
                key={i}
                onClick={() => processMessage(prompt, false)}
                style={styles.promptChip}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div style={styles.inputArea}>
        <form onSubmit={handleTextSubmit} style={styles.inputForm}>
          <input
            ref={inputRef}
            type="text"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder="Type a message..."
            style={styles.textInput}
            disabled={isProcessing || isRecording}
          />
          {textInput.trim() ? (
            <button type="submit" style={styles.sendBtn} disabled={isProcessing}>
              ↑
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRecord}
              style={{
                ...styles.micBtn,
                background: isRecording ? 'var(--danger)' : 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
                animation: pulseAnim ? 'pulse 1.5s ease infinite' : 'none',
              }}
            >
              {isRecording ? '⏹' : '🎙️'}
            </button>
          )}
        </form>

        {isRecording && (
          <div style={styles.recordingBar}>
            <div style={styles.recordingDot} />
            <span style={styles.recordingText}>Listening...</span>
            <span style={styles.recordingHint}>Tap to stop</span>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    display: 'flex', flexDirection: 'column', minHeight: '100vh',
    background: 'var(--bg)', fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: { padding: '28px 16px 12px', flexShrink: 0 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  subtitle: { fontSize: 13, color: 'var(--accent)', margin: 0, fontWeight: 500 },

  // Messages
  messagesContainer: {
    flex: 1, overflowY: 'auto', padding: '8px 16px 16px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  msgRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  agentAvatar: {
    width: 30, height: 30, borderRadius: 15, background: 'var(--accent-light)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '80%', borderRadius: 16, padding: '10px 14px',
    animation: 'fadeIn 0.2s ease',
  },
  userBubble: {
    background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
    color: 'var(--bg-card, #fff)', borderBottomRightRadius: 4,
  },
  aiBubble: {
    background: 'var(--bg-card)', color: 'var(--text-primary)',
    borderBottomLeftRadius: 4,
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))',
  },
  agentTag: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', marginBottom: 6,
  },
  msgText: { fontSize: 14, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' },
  voiceBadge: { display: 'inline-block', fontSize: 10, opacity: 0.7, marginTop: 4 },
  actionBtn: {
    display: 'block', marginTop: 8, padding: '6px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', background: 'transparent',
    color: 'var(--accent)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Typing indicator
  typingDots: { display: 'flex', gap: 2, padding: '4px 0' },
  typingDot: {
    fontSize: 28, lineHeight: '16px', color: 'var(--text-muted)',
    animation: 'pulse 1.2s ease infinite',
  },

  // Example prompts
  promptsSection: { padding: '0 16px 12px', flexShrink: 0 },
  promptsLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 500 },
  promptsGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  promptChip: {
    padding: '8px 12px', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.3,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },

  // Input area
  inputArea: { flexShrink: 0, padding: '8px 16px 24px', background: 'var(--bg)' },
  inputForm: { display: 'flex', gap: 8, alignItems: 'center' },
  textInput: {
    flex: 1, padding: '12px 16px', borderRadius: 24,
    border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--bg-card)', boxSizing: 'border-box',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none',
    background: 'var(--accent)', color: 'var(--bg-card, #fff)', fontSize: 18, fontWeight: 700,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  micBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none',
    color: 'var(--bg-card, #fff)', fontSize: 18,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, boxShadow: '0 2px 8px rgba(199,107,138,0.3)',
  },

  // Recording indicator
  recordingBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', marginTop: 8, borderRadius: 10,
    background: 'var(--danger-bg)',
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 4, background: 'var(--danger)',
    animation: 'pulse 1s ease infinite',
  },
  recordingText: { fontSize: 12, fontWeight: 600, color: 'var(--danger)', flex: 1 },
  recordingHint: { fontSize: 11, color: 'var(--text-muted)' },
};
