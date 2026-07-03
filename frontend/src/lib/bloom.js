/**
 * The Bloom — Florrie's signature moment.
 *
 * Petal-drift celebration (variant C) + warm two-note chime + success haptic.
 * Fires ONLY when Florrie completes work for the beautician (offer sent, gap
 * filled, day blocked, reply approved) — never on her own routine chores.
 *
 * Rules, from the signature-look research (docs and concept board):
 *  - under ~900ms, animate then rest, transform/opacity only
 *  - petals scatter from the last tap point so motion originates at its trigger
 *  - fully skipped under prefers-reduced-motion (haptic still fires)
 *  - per-device off switch (Settings > Celebrations), default ON
 */
import { hapticSuccess } from './native.js';

const KEY = 'florrie_celebrations_off';

export function celebrationsEnabled() {
  try { return localStorage.getItem(KEY) !== '1'; } catch { return true; }
}

export function setCelebrationsEnabled(on) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '1');
  } catch { /* ignore */ }
}

// Track the last pointer-down so the bloom can originate where Ellie tapped,
// without threading refs through every card component.
let lastPoint = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => {
    lastPoint = { x: e.clientX, y: e.clientY, at: Date.now() };
  }, { passive: true, capture: true });
}

// ---- Sound: warm two-note chime (E5 then B5), synthesised so there are no
// audio assets to load. Only ever called from a tap handler, so autoplay
// policies are satisfied.
let audioCtx = null;

function note(freq, t0, dur, gain, ac) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  const f = ac.createBiquadFilter();
  o.type = 'triangle';
  o.frequency.value = freq;
  f.type = 'lowpass';
  f.frequency.value = 2600;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(f); f.connect(g); g.connect(ac.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    note(659.25, t, 0.5, 0.10, audioCtx);          // E5
    note(987.77, t + 0.09, 0.65, 0.075, audioCtx); // B5
  } catch { /* sound is a garnish, never an error */ }
}

const PETAL_COLORS = ['#92405e', '#b56b85', '#e8b4c4', '#d8899f'];

/**
 * Fire the bloom. Origin priority: explicit element > recent tap point >
 * upper-centre of the viewport.
 */
export function bloom(el = null) {
  if (!celebrationsEnabled()) return;
  chime();
  hapticSuccess();
  try {
    if (typeof document === 'undefined') return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let x, y;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + Math.min(r.height / 2, 40);
    } else if (lastPoint && Date.now() - lastPoint.at < 4000) {
      x = lastPoint.x; y = lastPoint.y;
    } else {
      x = window.innerWidth / 2; y = window.innerHeight / 3;
    }

    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;pointer-events:none;z-index:9999;`;
    document.body.appendChild(host);

    for (let i = 0; i < 12; i++) {
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;width:10px;height:14px;left:-5px;top:-7px;' +
        'border-radius:50% 50% 50% 50% / 62% 62% 38% 38%;opacity:0;' +
        `background:${PETAL_COLORS[i % PETAL_COLORS.length]};`;
      host.appendChild(p);
      const ang = (Math.random() * 140 - 160) * Math.PI / 180; // mostly upward
      const dist = 30 + Math.random() * 55;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist;
      const drift = dy + 34 + Math.random() * 26;
      const rot0 = Math.random() * 360;
      const rot1 = rot0 + (Math.random() * 220 - 110);
      p.animate([
        { transform: `translate(0,0) rotate(${rot0}deg) scale(0.4)`, opacity: 0 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${(rot0 + rot1) / 2}deg) scale(1)`, opacity: 1, offset: 0.38 },
        { transform: `translate(${dx * 1.15}px, ${drift}px) rotate(${rot1}deg) scale(0.92)`, opacity: 0 },
      ], { duration: 760 + Math.random() * 180, delay: i * 14, easing: 'cubic-bezier(0.16, 0.84, 0.44, 1)', fill: 'forwards' });
    }
    setTimeout(() => host.remove(), 1400);
  } catch { /* celebration must never break the flow */ }
}

export default bloom;
