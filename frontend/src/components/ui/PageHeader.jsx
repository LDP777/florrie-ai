/**
 * PageHeader - the one consistent page header across Florrie.
 *
 * Title uses the canonical Noto Serif italic (matches the /today Hub
 * greeting) so every page feels like the same app. Optional subtitle and
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
  wrap: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingTop: 28, paddingBottom: 16 },
  text: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  title: {
    fontSize: 22, fontWeight: 700, fontStyle: 'italic',
    fontFamily: "'Noto Serif', Georgia, serif",
    color: 'var(--text-primary, #1d1b19)', margin: 0, lineHeight: 1.2,
  },
  subtitle: { fontSize: 13, color: 'var(--text-secondary, #867277)', margin: 0, fontWeight: 500 },
  action: { flexShrink: 0 },
};
