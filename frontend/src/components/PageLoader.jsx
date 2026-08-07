import { memo } from 'react';

function PageLoader({ message = 'Loading...' }) {
  return (
    <div style={S.wrap}>
      <div style={S.spinner} />
      <span style={S.text}>{message}</span>
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '40vh',
    gap: 12,
    animation: 'fadeIn 0.3s ease',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '2.5px solid var(--border, #EDE9E4)',
    borderTopColor: 'var(--accent, #C76B8A)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  text: {
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    letterSpacing: '0.04em',
  },
};

export default memo(PageLoader);
