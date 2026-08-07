import { useNavigate } from 'react-router-dom';
import Icon, { iconName } from './ui/Icon';

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
 * The shell (#app-scroll in App.jsx) owns the notch inset and the bottom
 * clearance for every page. This component must NOT pad either again, which is
 * the mistake it existed to prevent and was quietly making itself.
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
              <Icon name={iconName('arrow_back_ios_new')} size={22} inline />
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
    // The shell owns the notch. Padding it again here is the exact bug this
    // component exists to prevent, so it must not commit it itself.
    background: 'var(--bg)',
    zIndex: 'var(--z-header, 30)',
  },
  headerRow: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    minHeight: 52, padding: '8px 16px',
  },
  backBtn: {
    width: 44, height: 44, marginLeft: -8, borderRadius: 999, border: 'none',
    background: 'transparent', color: 'var(--accent)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  title: {
    flex: 1, minWidth: 0, margin: 0,
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
    fontSize: 26, fontWeight: 600, color: 'var(--text-primary)',
    letterSpacing: '-0.02em',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 },
  scroll: {
    // The shell reserves the floating nav and mic for every page, so this
    // region adds nothing. --scroll-pad-bottom is 0 and kept only so the pages
    // that already reference it stay correct.
    flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
    paddingBottom: 'var(--scroll-pad-bottom, 0px)',
  },
};
