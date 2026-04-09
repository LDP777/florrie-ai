import { memo } from 'react';
import { type } from '../lib/designSystem.js';

/**
 * PageHeader — consistent header for every page.
 *
 * Props:
 *   title       — page title (required)
 *   subtitle    — optional description line
 *   action      — optional ReactNode (button, icon, etc.) rendered top-right
 *   backLabel   — if set, shows a ← back link (uses navigate(-1))
 */
function PageHeader({ title, subtitle, action, children }) {
  return (
    <div style={S.wrap}>
      <div style={S.textWrap}>
        <h1 style={S.title}>{title}</h1>
        {subtitle && <p style={S.subtitle}>{subtitle}</p>}
      </div>
      {action && <div style={S.action}>{action}</div>}
      {children}
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 20,
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...type.displayMd,
    margin: 0,
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  subtitle: {
    ...type.bodySmall,
    marginTop: 4,
    margin: '4px 0 0',
  },
  action: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
};

export default memo(PageHeader);
