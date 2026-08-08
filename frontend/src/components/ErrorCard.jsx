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
    borderRadius: 10,
    background: 'var(--danger-bg, #F7E4E4)',
    border: '1px solid var(--danger-border, #EFCFCF)',
    marginBottom: 16,
    animation: 'fadeIn 0.2s ease',
  },
  text: {
    fontSize: 13,
    color: 'var(--danger, #9E2B32)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontWeight: 500,
    lineHeight: 1.4,
    flex: 1,
  },
  close: {
    background: 'none',
    border: 'none',
    fontSize: 18,
    color: 'var(--danger, #9E2B32)',
    cursor: 'pointer',
    padding: '0 0 0 12px',
    lineHeight: 1,
    fontWeight: 300,
    opacity: 0.7,
  },
};

export default memo(ErrorCard);
