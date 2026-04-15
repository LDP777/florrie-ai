/**
 * florrie.ai Design System — Shared Style Constants
 *
 * Import into any page:
 *   import { ds } from '../lib/designSystem.js';
 *
 * These reference CSS variables so they auto-adapt to light/dark mode.
 * Use alongside page-specific inline styles.
 */

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 };

export const radius = { sm: 8, md: 12, lg: 14, xl: 16, xxl: 20, full: 9999 };

export const type = {
  // Stitch: Playfair Display italic for hero/display text
  displayLg: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 28,
    fontWeight: 700,
    fontStyle: 'italic',
    letterSpacing: '-0.02em',
    lineHeight: 1.15,
    color: 'var(--accent, #92405e)',
  },
  displayMd: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 22,
    fontWeight: 700,
    fontStyle: 'italic',
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
    color: 'var(--text-primary)',
  },
  displaySm: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 18,
    fontWeight: 700,
    fontStyle: 'italic',
    letterSpacing: '-0.01em',
    lineHeight: 1.25,
    color: 'var(--text-primary)',
  },
  // Stitch: Noto Serif for section headlines
  headline: {
    fontFamily: "var(--font-headline, 'Noto Serif', Georgia, serif)",
    fontSize: 24,
    fontWeight: 400,
    fontStyle: 'italic',
    lineHeight: 1.2,
    color: 'var(--text-primary)',
  },
  heading: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: 'var(--text-primary)',
  },
  body: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
  },
  bodySmall: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 13,
    fontWeight: 400,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
  // Stitch: uppercase tracking labels
  label: {
    fontFamily: "var(--font-label, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  caption: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  mono: {
    fontFamily: "var(--font-mono, 'DM Mono', monospace)",
    fontSize: 13,
    fontWeight: 400,
  },
};

export const ds = {
  // Page wrapper
  page: {
    padding: '16px 16px 100px',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    maxWidth: 480,
    margin: '0 auto',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },

  // Page title (uses Playfair Display)
  pageTitle: {
    ...type.displayMd,
    margin: 0,
  },

  // Section title
  sectionTitle: {
    ...type.caption,
    marginBottom: 10,
  },

  // Card
  card: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 16,
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-xs)',
  },

  cardElevated: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 16,
    border: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-md)',
  },

  // Hero card (gradient) — Stitch primary gradient
  heroCard: {
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    borderRadius: 24,
    padding: 24,
    color: '#fff',
    boxShadow: '0 8px 24px rgba(146, 64, 94, 0.2)',
    position: 'relative',
    overflow: 'hidden',
  },

  // Pill tabs
  tabBar: {
    display: 'flex',
    gap: 4,
    marginBottom: 16,
    background: 'var(--bg-subtle, #F5F2EF)',
    borderRadius: 14,
    padding: 4,
  },

  tab: {
    flex: 1,
    padding: '9px 0',
    fontSize: 13,
    fontWeight: 500,
    border: 'none',
    borderRadius: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: 'none',
    color: 'var(--text-secondary)',
    transition: 'all 0.2s ease',
  },

  tabActive: {
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    boxShadow: 'var(--shadow-sm)',
    fontWeight: 600,
  },

  // Input
  input: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 12,
    border: '1.5px solid var(--border)',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },

  // Label
  inputLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 6,
    letterSpacing: '0.01em',
  },

  // Toggle switch
  toggle: {
    width: 44,
    height: 24,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    flexShrink: 0,
    transition: 'background 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },

  toggleDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    background: '#fff',
    position: 'absolute',
    top: 2,
    left: 2,
    transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
  },

  // Primary button
  btnPrimary: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 14,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.25)',
    transition: 'all 0.15s ease',
  },

  btnSecondary: {
    padding: '10px 16px',
    borderRadius: 12,
    border: '1.5px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s ease',
  },

  btnGhost: {
    padding: '8px 14px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-hover)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Badge
  badge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 8,
  },

  badgeAccent: {
    background: 'var(--accent-light)',
    color: 'var(--accent-text, var(--accent))',
  },

  badgeGold: {
    background: 'var(--gold-light)',
    color: 'var(--gold-text, var(--gold))',
  },

  badgeSuccess: {
    background: 'var(--success-bg)',
    color: 'var(--success-text, var(--success))',
  },

  badgeWarning: {
    background: 'var(--warning-bg)',
    color: 'var(--warning-text, var(--warning))',
  },

  badgeDanger: {
    background: 'var(--danger-bg)',
    color: 'var(--danger-text, var(--danger))',
  },

  // Insight / AI card — Stitch tertiary-fixed tinted
  insightCard: {
    display: 'flex',
    gap: 12,
    background: 'rgba(243, 223, 211, 0.4)',
    border: '1px solid rgba(116, 90, 39, 0.1)',
    borderRadius: 24,
    padding: 20,
    position: 'relative',
    overflow: 'hidden',
  },

  // Stat grid
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 10,
    marginBottom: 16,
  },

  statCard: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 14,
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-xs)',
  },

  statValue: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: "var(--font-body)",
  },

  statLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 2,
  },

  // Divider
  divider: {
    height: 1,
    background: 'var(--border)',
    margin: '12px 0',
    border: 'none',
  },

  // Row / list item
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '13px 0',
    borderBottom: '1px solid var(--border-light)',
  },

  // Empty state
  empty: {
    textAlign: 'center',
    padding: '40px 20px',
    color: 'var(--text-muted)',
    fontSize: 14,
  },
};

export default ds;
