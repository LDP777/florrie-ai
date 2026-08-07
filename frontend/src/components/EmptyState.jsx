import { memo } from 'react';
import Icon, { iconName } from './ui/Icon';

function EmptyState({ icon = 'inbox', title = 'Nothing here yet', subtitle, actionLabel, onAction }) {
  return (
    <div style={S.wrap}>
      <span style={S.icon}><Icon name={iconName(icon, 'inbox')} size={34} strokeWidth={1.3} /></span>
      <h3 style={S.title}>{title}</h3>
      {subtitle && <p style={S.subtitle}>{subtitle}</p>}
      {actionLabel && onAction && (
        <button onClick={onAction} style={S.btn}>{actionLabel}</button>
      )}
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '48px 24px',
    animation: 'fadeIn 0.3s ease',
  },
  icon: {
    lineHeight: 1,
    marginBottom: 14,
    color: 'var(--accent, #92405E)',
    opacity: 0.45,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    margin: 0,
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--text-muted, #B5AFA8)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    margin: '8px 0 0',
    maxWidth: 280,
    lineHeight: 1.5,
  },
  btn: {
    marginTop: 16,
    padding: '10px 20px',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
};

export default memo(EmptyState);
