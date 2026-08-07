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
    border: '2.5px solid var(--border, #E8DDD4)',
    borderTopColor: 'var(--accent, #92405e)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  text: {
    fontSize: 12,
    color: 'var(--text-muted, #6B5D54)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    letterSpacing: '0.04em',
  },
};

export default memo(PageLoader);
