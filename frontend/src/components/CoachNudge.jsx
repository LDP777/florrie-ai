/**
 * CoachNudge - The Biz Coach contextual insight card.
 *
 * Slides up from the bottom of the screen when Florrie spots an opportunity,
 * warning, or useful insight. Non-blocking - the beautician can dismiss it
 * instantly or tap the CTA to act on it.
 *
 * Auto-dismisses after 12 seconds (progress bar shows countdown).
 */

import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoach } from '../contexts/CoachContext.jsx';
import Icon, { iconName } from './ui/Icon';

const URGENCY_COLOURS = {
  opportunity: { bg: 'linear-gradient(135deg, #7B6BA8 0%, #9B8BC8 100%)', accent: '#C9A96E', pill: '#F5F0FF', pillText: '#7B6BA8', label: 'OPPORTUNITY' },
  warning:     { bg: 'linear-gradient(135deg, #C76B8A 0%, #E8A0B5 100%)', accent: '#fff',    pill: '#FFF0F3', pillText: '#C76B8A', label: 'HEADS UP'    },
  info:        { bg: 'linear-gradient(135deg, #5A7A8A 0%, #7BA0B0 100%)', accent: '#C9A96E', pill: '#F0F6F9', pillText: '#5A7A8A', label: 'BIZ INSIGHT' },
};

const MAT_ICONS = {
  trending_up: 'trending_up',
  warning:     'warning',
  lightbulb:   'lightbulb',
  money_off:   'money_off',
  groups:      'groups',
};

const AUTO_DISMISS_MS = 12000;

export default function CoachNudge() {
  const { nudge, dismiss } = useCoach();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(100);
  const startRef = useRef(null);
  const rafRef = useRef(null);
  const prevNudgeId = useRef(null);

  // Animate in when nudge appears
  useEffect(() => {
    if (nudge && nudge.id !== prevNudgeId.current) {
      prevNudgeId.current = nudge.id;
      setProgress(100);
      startRef.current = Date.now();
      setVisible(true);

      // Progress bar countdown
      const tick = () => {
        const elapsed = Date.now() - startRef.current;
        const pct = Math.max(0, 100 - (elapsed / AUTO_DISMISS_MS) * 100);
        setProgress(pct);
        if (pct > 0) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }
    if (!nudge) {
      setVisible(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [nudge]);

  if (!nudge) return null;

  const colours = URGENCY_COLOURS[nudge.urgency] || URGENCY_COLOURS.info;
  const matIcon = MAT_ICONS[nudge.icon] || 'lightbulb';

  function handleCta() {
    dismiss();
    if (nudge.cta_path) navigate(nudge.cta_path);
  }

  return (
    <div
      style={{ position: 'fixed',
        bottom: 80, // above bottom nav
        left: '50%',
        transform: `translateX(-50%) translateY(${visible ? '0' : '120px'})`,
        width: 'calc(100% - 32px)',
        maxWidth: 460,
        zIndex: 9999,
        transition: 'transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1)',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
      }}
    >
      {/* Main card */}
      <div style={{ background: '#fff', position: 'relative' }}>

        {/* Coloured header strip */}
        <div style={{ background: colours.bg, padding: '14px 16px 12px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {/* Icon circle */}
          <div style={{ width: 38, height: 38, borderRadius: 19,
            background: 'rgba(255,255,255,0.22)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon name={iconName(matIcon)} size={20} inline style={{ color: '#fff' }} />
          </div>

          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                color: 'rgba(255,255,255,0.85)', textTransform: 'uppercase',
              }}>
                BIZ COACH · {colours.label}
              </span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1.25 }}>
              {nudge.headline}
            </div>
          </div>

          {/* Dismiss */}
          <button
            onClick={dismiss}
            style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 12,
              width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0, padding: 0,
            }}
            aria-label="Dismiss"
          >
            <Icon name={iconName('close')} size={15} inline style={{ color: '#fff' }} />
          </button>
        </div>

        {/* Body + CTA */}
        <div style={{ padding: '12px 16px 14px', background: '#fff' }}>
          <p style={{ fontSize: 13, color: '#4A4540', lineHeight: 1.5,
            margin: '0 0 12px', fontWeight: 400,
          }}>
            {nudge.body}
          </p>
          {nudge.cta_label && nudge.cta_path && (
            <button
              onClick={handleCta}
              style={{ width: '100%', padding: '10px 16px', borderRadius: 10, border: 'none',
                background: colours.bg, color: '#fff',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'inherit', letterSpacing: '0.01em',
              }}
            >
              {nudge.cta_label} →
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div style={{ height: 3, background: '#F0ECE8' }}>
          <div style={{ height: '100%', background: colours.bg,
            width: `${progress}%`, transition: 'width 0.1s linear',
          }} />
        </div>
      </div>
    </div>
  );
}
