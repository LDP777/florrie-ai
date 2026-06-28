/**
 * Per-treatment colours for the calendar.
 *
 * A curated, muted palette that reads well on the cream (#fef8f4) background.
 * Nothing neon, nothing that fights the accent. Each treatment gets a stable
 * colour from its sort_order (falling back to a hash of its id) so the mapping
 * stays consistent across days and reloads, even before Ellie customises it.
 */

// About a dozen elegant, clearly distinct tones. Ordered so adjacent
// sort_order treatments land on visibly different hues.
export const TREATMENT_PALETTE = [
  '#92405e', // brand rose
  '#6e8b6a', // sage
  '#c08552', // warm caramel
  '#5d7b9a', // dusty blue
  '#a8597a', // mauve pink
  '#7a6aa0', // muted violet
  '#b8843f', // ochre
  '#4f857d', // teal
  '#b56b6b', // terracotta
  '#8a7d52', // olive
  '#5a8aa0', // slate cyan
  '#9c6a8e', // plum
];

/** Small stable hash of a string -> non-negative integer. */
function hashStr(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * The colour for a treatment. Returns its saved colour if set, otherwise a
 * stable palette colour derived from sort_order (or a hash of its id).
 */
export function treatmentColor(treatment) {
  if (!treatment) return TREATMENT_PALETTE[0];
  if (treatment.color) return treatment.color;
  const order = treatment.sort_order;
  const idx = (Number.isInteger(order) ? order : hashStr(treatment.id)) % TREATMENT_PALETTE.length;
  return TREATMENT_PALETTE[idx];
}

/**
 * Soft translucent version of a hex colour, for tinted backgrounds.
 * tint('#92405e', 0.1) -> 'rgba(146, 64, 94, 0.1)'.
 */
export function tint(hex, alpha = 0.12) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(146, 64, 94, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
