import { memo } from 'react';

function ErrorCard({ message = 'Something went wrong', onDismiss }) {
  return (
    <div style={S.wrap}>
      <span style={S.text}>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={S.close} aria-label="Dismiss error">&times;</button>
      )}
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderRadius: 12,
    background: 'var(--danger-bg, #FFF0F0)',
    border: '1px solid var(--danger-border, #FFD4D4)',
    marginBottom: 16,
    animation: 'fadeIn 0.2s ease',
  },
  text: {
    fontSize: 13,
    color: 'var(--danger, #D44)',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    fontWeight: 500,
    lineHeight: 1.4,
    flex: 1,
  },
  close: {
    background: 'none',
    border: 'none',
    fontSize: 18,
    color: 'var(--danger, #D44)',
    cursor: 'pointer',
    padding: '0 0 0 12px',
    lineHeight: 1,
    fontWeight: 300,
    opacity: 0.7,
  },
};

export default memo(ErrorCard);
