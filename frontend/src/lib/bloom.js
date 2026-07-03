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
    spawnPetals(host, 1, 12);
    setTimeout(() => host.remove(), 1400);
  } catch { /* celebration must never break the flow */ }
}

function spawnPetals(host, scale, n) {
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    p.style.cssText = `position:absolute;width:${10 * scale}px;height:${14 * scale}px;left:${-5 * scale}px;top:${-7 * scale}px;` +
      'border-radius:50% 50% 50% 50% / 62% 62% 38% 38%;opacity:0;' +
      `background:${PETAL_COLORS[i % PETAL_COLORS.length]};`;
    host.appendChild(p);
    const ang = (Math.random() * 140 - 160) * Math.PI / 180; // mostly upward
    const dist = (30 + Math.random() * 55) * scale;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist;
    const drift = dy + (34 + Math.random() * 26) * scale;
    const rot0 = Math.random() * 360;
    const rot1 = rot0 + (Math.random() * 220 - 110);
    p.animate([
      { transform: `translate(0,0) rotate(${rot0}deg) scale(0.4)`, opacity: 0 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${(rot0 + rot1) / 2}deg) scale(1)`, opacity: 1, offset: 0.38 },
      { transform: `translate(${dx * 1.15}px, ${drift}px) rotate(${rot1}deg) scale(0.92)`, opacity: 0 },
    ], { duration: (760 + Math.random() * 180) * (scale > 1 ? 1.25 : 1), delay: i * 14, easing: 'cubic-bezier(0.16, 0.84, 0.44, 1)', fill: 'forwards' });
  }
}

/**
 * The rare, big version: full-screen petal moment with a shareable line.
 * Fires once per milestone (callers track what has been seen). Tap anywhere
 * to dismiss; Share uses the native sheet where available, else clipboard.
 */
export function milestoneBloom({ title, sub = '', shareText = '' }) {
  if (!celebrationsEnabled()) return;
  if (typeof document === 'undefined') return;
  try {
    chime();
    hapticSuccess();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;background:rgba(254,248,244,0.96);';
    const anchor = document.createElement('div');
    anchor.style.cssText = 'position:relative;width:0;height:0;';
    const h = document.createElement('h2');
    h.textContent = title;
    h.style.cssText = "font-family:var(--font-display, 'Playfair Display', Georgia, serif);font-size:26px;font-weight:700;color:var(--accent, #92405e);margin:96px 0 0;max-width:320px;line-height:1.25;opacity:0;";
    const p = document.createElement('p');
    p.textContent = sub;
    p.style.cssText = 'font-size:14px;color:var(--text-secondary, #867277);margin:10px 0 0;max-width:300px;line-height:1.5;opacity:0;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:26px;opacity:0;';
    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `min-height:44px;padding:0 22px;border-radius:12px;border:none;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;background:${primary ? 'var(--accent, #92405e)' : 'var(--tone-2, #f6e7dd)'};color:${primary ? '#fff' : 'var(--accent, #92405e)'};`;
      return b;
    };
    const shareBtn = shareText ? mkBtn('Share it', true) : null;
    const closeBtn = mkBtn('Lovely', !shareText);
    if (shareBtn) {
      shareBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (navigator.share) await navigator.share({ text: shareText });
          else { await navigator.clipboard.writeText(shareText); shareBtn.textContent = 'Copied!'; return; }
        } catch { /* user cancelled */ }
        ov.remove();
      });
      row.appendChild(shareBtn);
    }
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); ov.remove(); });
    row.appendChild(closeBtn);
    ov.addEventListener('click', () => ov.remove());
    ov.appendChild(anchor); ov.appendChild(h); ov.appendChild(p); ov.appendChild(row);
    document.body.appendChild(ov);

    if (!reduce) {
      spawnPetals(anchor, 2.4, 14);
      setTimeout(() => spawnPetals(anchor, 2.0, 12), 300);
      [h, p, row].forEach((el, i) => {
        el.animate(
          [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 400, delay: 450 + i * 140, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
        );
      });
    } else {
      [h, p, row].forEach(el => { el.style.opacity = 1; });
    }
  } catch { /* never break the app for a party */ }
}

export default bloom;
