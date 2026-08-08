/**
 * Make a salon's brand colour readable without making it a different colour.
 *
 * The public booking page uses `beautician.brand_colour` raw, as a text colour,
 * on cream. Ellindigo's is #c76b8a, which measures 3.32:1 against #FBF6F1 — so
 * the step she is currently on, and the footer, are below AA on the page her
 * clients pay through. Dark text sitting ON that same pink measures 2.39:1.
 *
 * That is not three bugs, it is one: a colour a user picks is used unmodified
 * in a context that has a contrast requirement. Fixing the three call sites
 * fixes Ellindigo and breaks for whoever picks a pale peach next.
 *
 * So: keep the hue and the saturation, move only the lightness, and stop as
 * soon as it passes. The result still reads as her brand — the same pink, a
 * shade deeper — rather than being swapped for a safe grey.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function parse(hex) {
  const h = String(hex || '').trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

function luminance({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 1;
  const lx = luminance(x), ly = luminance(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function toRgb({ h, s, l }) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255) };
}

/**
 * The brand colour, darkened (or lightened, on a dark ground) only as far as it
 * has to be to meet `min` against `bg`.
 *
 * Returns the original untouched when it already passes, so a salon with a deep
 * brand colour sees exactly the colour they chose.
 */
export function readableOn(brand, bg = '#FBF6F1', min = 4.5) {
  const rgb = parse(brand);
  if (!rgb) return brand;                       // not a hex we understand; leave it alone
  if (contrast(brand, bg) >= min) return brand;

  const bgLum = luminance(parse(bg) || { r: 255, g: 255, b: 255 });
  const hsl = toHsl(rgb);
  // On a light ground go darker; on a dark ground go lighter.
  const step = bgLum > 0.5 ? -0.02 : 0.02;

  let { l } = hsl;
  for (let i = 0; i < 50; i++) {
    l = clamp(l + step, 0, 1);
    const candidate = toHex(toRgb({ ...hsl, l }));
    if (contrast(candidate, bg) >= min) return candidate;
    if (l === 0 || l === 1) break;
  }
  // Ran out of lightness — the hue cannot reach `min` at any lightness, which
  // happens for very saturated yellows. Fall back to the page's ink rather than
  // returning something unreadable.
  return bgLum > 0.5 ? '#241B17' : '#FBF6F1';
}

/**
 * What to write ON the brand colour: whichever of ink or cream reads better.
 * Ellindigo's pink takes ink; a deep maroon takes cream.
 */
export function onBrand(brand, ink = '#241B17', cream = '#FFFFFF') {
  return contrast(ink, brand) >= contrast(cream, brand) ? ink : cream;
}
