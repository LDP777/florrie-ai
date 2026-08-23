import { Children, Fragment, isValidElement } from 'react';

/**
 * PageHeader - the one consistent page header across Florrie.
 *
 * Title uses Playfair Display italic (matches the /today Hub greeting)
 * so every page feels like the same app. Presentational only.
 *
 * Props:
 *   title     required. The page name.
 *   subtitle  optional. One line under the title.
 *   eyebrow   optional. Sits ABOVE the title. Pass a string for the standard
 *             uppercase accent label (Set up, Beta, and so on) and it gets
 *             styled here; pass a node when the slot holds something with its
 *             own look, such as a breadcrumb <Link>, and it is rendered as
 *             given. Two shapes, one slot, because a breadcrumb painted in
 *             10.5px accent capitals is not a breadcrumb any more.
 *   action    optional. The right-hand slot. A single node, an array, or a
 *             fragment: several pages want a button next to a status badge,
 *             or an Add button next to an overflow trigger. Fragments are
 *             unwrapped so their children lay out as siblings in the row
 *             rather than as one opaque child, which also means a fragment of
 *             conditionals that all evaluate false counts as no action and
 *             the slot is not rendered at all. An empty slot still costs the
 *             wrap's 12px gap, and that gap eats into the space the title has
 *             to wrap in, so this matters more than it looks.
 *
 * The action container is position:relative on purpose. Popovers anchored
 * inside it (the Clients overflow menu) resolve against the header instead of
 * against whatever distant ancestor happens to be positioned, which is how
 * one of them ended up clipped against #app-scroll's overflowX: hidden.
 */
export default function PageHeader({ title, subtitle, eyebrow, action }) {
  const actions = slotItems(action);
  const eyebrowNode = typeof eyebrow === 'string' || typeof eyebrow === 'number'
    ? <div style={S.eyebrow}>{eyebrow}</div>
    : eyebrow;

  return (
    <div style={S.wrap}>
      <div style={S.text}>
        {eyebrowNode ? <div style={S.eyebrowSlot}>{eyebrowNode}</div> : null}
        <h1 style={S.title}>{title}</h1>
        {subtitle && <p style={S.subtitle}>{subtitle}</p>}
      </div>
      {actions.length > 0 && <div style={S.action}>{actions}</div>}
    </div>
  );
}

// Unwrap bare fragments, then flatten and key whatever is left. Children.toArray
// drops null, undefined and booleans for us, but it treats a fragment as a
// single child, so an unwrapped pass is what makes {saved && ...}{error && ...}
// collapse to nothing when neither is true.
function slotItems(node) {
  let n = node;
  while (isValidElement(n) && n.type === Fragment) n = n.props.children;
  return Children.toArray(n);
}

const S = {
  // The pill band is reserved by the scroll region in App.jsx now, for every
  // screen rather than for the nine that happen to use this component. Padding
  // it again here would push those nine down by 60px twice.
  //
  // This padding was right, and being right in one component was the problem:
  // sixty-odd screens roll their own header, so the app looked correct exactly
  // where this was imported and broken everywhere else.
  wrap: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingTop: 4, paddingBottom: 16 },
  text: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  eyebrowSlot: { minWidth: 0 },
  eyebrow: {
    fontSize: 10.5, fontWeight: 800, letterSpacing: '0.16em',
    textTransform: 'uppercase', color: 'var(--accent, #92405e)',
  },
  title: {
    fontSize: 26, fontWeight: 600, fontStyle: 'italic',
    fontFamily: "'Playfair Display', Georgia, serif",
    color: 'var(--text-primary, #241B17)', margin: 0, lineHeight: 1.2,
    letterSpacing: '-0.01em',
  },
  subtitle: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: 0, fontWeight: 500 },
  action: { flexShrink: 0, position: 'relative', display: 'flex', alignItems: 'center', gap: 8 },
};
