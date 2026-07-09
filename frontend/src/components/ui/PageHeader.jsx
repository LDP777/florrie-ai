/**
 * PageHeader - the one consistent page header across Florrie.
 *
 * Title uses Playfair Display italic (matches the /today Hub greeting)
 * so every page feels like the same app. Optional subtitle and
 * an optional right-side action slot (button, etc.). Presentational only.
 */
export default function PageHeader({ title, subtitle, action }) {
  return (
    <div style={S.wrap}>
      <div style={S.text}>
        <h1 style={S.title}>{title}</h1>
        {subtitle && <p style={S.subtitle}>{subtitle}</p>}
      </div>
      {action && <div style={S.action}>{action}</div>}
    </div>
  );
}

const S = {
  // Top padding clears the fixed Back/More pill band (safe-area + 12px top +
  // 44px pill) so the title and the right-side action are never underneath
  // them - the action slot used to sit exactly under the More pill, which
  // made buttons like "+ New Post" untappable.
  wrap: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingTop: 60, paddingBottom: 16 },
  text: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  title: {
    fontSize: 26, fontWeight: 600, fontStyle: 'italic',
    fontFamily: "'Playfair Display', Georgia, serif",
    color: 'var(--text-primary, #2b1d22)', margin: 0, lineHeight: 1.2,
    letterSpacing: '-0.01em',
  },
  subtitle: { fontSize: 13, color: 'var(--text-secondary, #6e5a60)', margin: 0, fontWeight: 500 },
  action: { flexShrink: 0 },
};
