import { useEffect, useRef } from 'react';
import { useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import { FlorrieOrb } from './ui/FlorrieEffects.jsx';
import Icon from './ui/Icon.jsx';

/** A decorative colour wave only. The controller never receives client DOM or images. */
export function ContentReveal({ event, children, className = '' }) {
  const { hidden } = useClientPrivacy();
  const root = useRef(null), surface = useRef(null), seen = useRef(null);
  useEffect(() => {
    if (!event || event === seen.current) return;
    seen.current = event;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (hidden || motion.matches || document.hidden) return;
    let stopped = false, controller, timer, observer;
    const host = root.current;
    const stop = () => {
      stopped = true;
      clearTimeout(timer); observer?.disconnect(); controller?.destroy();
      if (host) host.dataset.revealState = 'complete';
    };
    const visibility = () => { if (document.hidden) stop(); };
    const reduced = () => { if (motion.matches) stop(); };
    const play = async () => {
      observer?.disconnect();
      clearTimeout(timer);
      try {
        const { WaveController } = await import('../vendor/distortion-waves/controller.ts');
        if (stopped || hidden || motion.matches || document.hidden || !host?.isConnected) return;
        controller = new WaveController(host, surface.current);
        controller.update({
          capture: false, prewarm: false, live: false, resolution: 1,
          reducedMotion: 'system', type: 'vertical',
          palette: getComputedStyle(host).getPropertyValue('--accent').trim(),
          waveStyle: {
            anticipation: 0, travel: .55, linger: 0, rimFade: .45,
            hairlineLinger: 0, hairlineFade: .45, particleLife: 0, particleCount: 0,
            pull: 0, inhale: 0, blur: 0, amplitude: 0, strength: .24,
            rimWidth: 3, rimStrength: .22, hairlineOpacity: 0,
          },
          onFinish: stop,
        });
        host.dataset.revealState = 'playing';
        controller.play();
        // Decoration has a hard lifetime, including a lost WebGL context.
        timer = setTimeout(stop, 850);
      } catch { stop(); } // The result and its controls are already usable.
    };
    motion.addEventListener('change', reduced);
    document.addEventListener('visibilitychange', visibility);
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) void play();
      });
      observer.observe(host);
      timer = setTimeout(stop, 8000); // Do not replay old results on a later scroll.
    } else void play();
    return () => {
      stop(); motion.removeEventListener('change', reduced);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [event, hidden]);
  return <div className={`fl-content-reveal ${className}`}>
    {children}
    <div ref={root} className="fl-content-reveal-colour" aria-hidden="true" data-content-reveal="" data-reveal-state="idle"><div ref={surface}/></div>
  </div>;
}

export default function ContentPreparation({ stage, progress }) {
  const saving = progress?.phase === 'artwork';
  return <div className="fl-content-preparing" role="status" aria-live="polite" aria-atomic="true">
    <span className="fl-content-preparing-mark" aria-hidden="true"><Icon name="flower" size={28}/></span>
    <div className="fl-content-preparing-copy"><strong>{saving ? 'Bringing it together' : 'A little less on your list'}</strong><span>{stage || 'Preparing your posts…'}</span>
      <small>{saving && progress.total > 0 ? `${progress.completed} of ${progress.total} designs saved · Keep Content open` : 'Keep Content open until your drafts are saved.'}</small>
    </div>
    <FlorrieOrb state={saving ? 'shaping' : 'composing'} size={20}/>
    <span className="fl-content-preparing-line" aria-hidden="true"/>
  </div>;
}
