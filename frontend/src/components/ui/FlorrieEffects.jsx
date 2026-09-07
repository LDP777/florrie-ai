import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTheme } from '../../lib/theme.jsx';
import Icon from './Icon.jsx';

const Orb = lazy(() => import('thinking-orbs').then(module => ({ default: module.ThinkingOrb })));
const Beam = lazy(() => import('border-beam').then(module => ({ default: module.BorderBeam })));
const LiquidSurface = lazy(() => import('./LiquidSurface.jsx'));

// Effects cannot replace an input, interrupt a save or take down a page.
class DecorationBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function useVisibleEffect() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    motion(); media.addEventListener('change', motion);
    let inView = false;
    const update = () => setVisible(inView && document.visibilityState !== 'hidden');
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting); update();
    });
    if (observer && ref.current) observer.observe(ref.current);
    else { inView = true; update(); }
    document.addEventListener('visibilitychange', update);
    return () => { observer?.disconnect(); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', update); };
  }, []);
  return { ref, visible, reduced };
}

/** The idle orb is a brand avatar. Working/listening states require real UI state. */
export function FlorrieOrb({ state = 'weaving', size = 64, className = '', inverse = false, paused = false }) {
  const { ref, visible, reduced } = useVisibleEffect();
  const { isDark } = useTheme();
  const fallback = <Icon name="flower" size={Math.min(size * .55, 38)} />;
  return <span ref={ref} className={`fl-orb ${className}`} style={{ width: size, height: size }} aria-hidden="true" data-effect="thinking-orbs" data-orb-state={state}>
    {visible ? <DecorationBoundary fallback={fallback}><Suspense fallback={fallback}>
      <Orb state={state} size={size <= 24 ? 20 : 64} theme={inverse ? 'dark' : isDark ? 'dark' : 'light'} speed={.7} paused={paused || reduced} aria-hidden="true" style={{ width: size, height: size }} />
    </Suspense></DecorationBoundary> : fallback}
  </span>;
}

/** The content remains mounted; only a non-interactive border is enhanced. */
export function EffectFrame({ children, active = false, focus = false, className = '', style }) {
  const { ref, visible, reduced } = useVisibleEffect();
  const { isDark } = useTheme();
  const [focused, setFocused] = useState(false);
  const enabled = active || (focus && focused);
  return <div ref={ref} className={`fl-effect-frame ${className}`} style={style} data-effect="border-beam" data-effect-active={enabled}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {children}
    {visible && enabled && !reduced && <span className="fl-effect-overlay" aria-hidden="true"><DecorationBoundary fallback={null}><Suspense fallback={null}>
      <Beam className="fl-effect-beam" size="pulse-inner" colorVariant="mono" theme={isDark ? 'dark' : 'light'} strength={.45} duration={3.6} staticColors active><div style={{ width: '100%', height: '100%', borderRadius: 'inherit' }} /></Beam>
    </Suspense></DecorationBoundary></span>}
  </div>;
}

/** A liquid selection surface behind existing, unchanged tab buttons. */
export function LiquidIndicator({ index, count, className = '' }) {
  const { ref, visible, reduced } = useVisibleEffect();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const read = () => setWidth(ref.current?.getBoundingClientRect().width || 0);
    read();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(ref.current);
    return () => observer?.disconnect();
  }, []);
  const valid = index >= 0 && index < count && count > 0;
  const fallback = valid ? <span className="fl-liquid-static" style={{ width: `${100 / count}%`, left: `${100 * index / count}%` }} /> : null;
  return <span ref={ref} className={`fl-liquid-indicator ${className}`} data-effect="liquid-gooey" aria-hidden="true">
    {valid && visible && !reduced && width ? <DecorationBoundary fallback={fallback}><Suspense fallback={fallback}>
      <LiquidSurface width={width} count={count} index={index} />
    </Suspense></DecorationBoundary> : fallback}
  </span>;
}
