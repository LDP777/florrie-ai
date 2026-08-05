import { useNavigate } from 'react-router-dom';

/**
 * PageScaffold , the single layout primitive every screen should use.
 *
 * Solves the recurring "buttons covered by the nav" and "headers overlap" bugs
 * by convention (see docs/UX_BLUEPRINT.md):
 *  - exactly ONE header owns the top safe-area inset (no second top-corner element),
 *  - the title + actions live in that one header so they never collide,
 *  - the ONE scroll region reserves nav height + bottom inset, so nothing ever
 *    hides under the fixed bottom nav.
 *
 * Pages that adopt this should NOT also render the global FloatingBack/More
 * (App.jsx suppresses those on own-header routes).
 *
 * NOTHING IMPORTS THIS YET, ON PURPOSE. It landed with the design tokens ahead
 * of the screen-by-screen rollout, so a dead-code scan will keep flagging it.
 * It is the target shape, not an orphan: delete it and the next person fixes
 * the same nav-overlap bug a fourth time.
 *
 * Props:
 *   title     screen title (string)
 *   onBack    if set, shows a back button (defaults to history back)
 *   actions   optional right-aligned action node(s)
 *   children  page body (scrolls)
 */
export default function PageScaffold({ title, onBack, actions, children }) {
  const navigate = useNavigate();
  const back = onBack || (() => (window.history.length > 1 ? navigate(-1) : navigate('/')));

  return (
    <div style={S.shell}>
      <header style={S.header}>
        <div style={S.headerRow}>
          {onBack !== null && (
            <button onClick={back} aria-label="Back" style={S.backBtn}>
              <span className="material-symbols-outlined" style={{ fontSize: 22 }}>arrow_back_ios_new</span>
            </button>
          )}
          {title && <h1 style={S.title}>{title}</h1>}
          <div style={S.actions}>{actions}</div>
        </div>
      </header>
      <div style={S.scroll} id="page-scroll">{children}</div>
    </div>
  );
}

const S = {
  shell: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  header: {
    flexShrink: 0,
    paddingTop: 'var(--safe-top, env(safe-area-inset-top, 0px))',
    background: '#fef8f4',
    zIndex: 'var(--z-header, 30)',
  },
  headerRow: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    minHeight: 52, padding: '8px 16px',
  },
  backBtn: {
    width: 44, height: 44, marginLeft: -8, borderRadius: 999, border: 'none',
    background: 'transparent', color: '#92405e', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  title: {
    flex: 1, minWidth: 0, margin: 0,
    fontFamily: "'Playfair Display', 'Noto Serif', Georgia, serif",
    fontSize: 26, fontWeight: 600, color: '#1d1b19',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 },
  scroll: {
    flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
    paddingBottom: 'var(--scroll-pad-bottom, calc(56px + env(safe-area-inset-bottom, 0px) + 16px))',
  },
};
