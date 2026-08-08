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
  // The pill band is reserved by the scroll region in App.jsx now, for every
  // screen rather than for the nine that happen to use this component. Padding
  // it again here would push those nine down by 60px twice.
  //
  // This padding was right, and being right in one component was the problem:
  // sixty-odd screens roll their own header, so the app looked correct exactly
  // where this was imported and broken everywhere else.
  wrap: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingTop: 4, paddingBottom: 16 },
  text: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  title: {
    fontSize: 26, fontWeight: 600, fontStyle: 'italic',
    fontFamily: "'Playfair Display', Georgia, serif",
    color: 'var(--text-primary, #241B17)', margin: 0, lineHeight: 1.2,
    letterSpacing: '-0.01em',
  },
  subtitle: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: 0, fontWeight: 500 },
  action: { flexShrink: 0 },
};
