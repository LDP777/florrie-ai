/**
 * MessagePreview - shows an outgoing message exactly as the client receives it,
 * as a true-to-life phone chat bubble. Used wherever the beautician previews a
 * message (templates, drafts) so "send" feels real and trustworthy.
 */
export default function MessagePreview({ text, salonName = 'Your salon', channel = 'WhatsApp' }) {
  const name = (salonName || 'Your salon').trim();
  const initial = name.charAt(0).toUpperCase() || 'F';
  return (
    <div style={S.phone}>
      <div style={S.header}>
        <div style={S.avatar}>{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.name}>{name}</div>
          <div style={S.channel}><span style={S.dot} />{channel} Business</div>
        </div>
      </div>
      <div style={S.body}>
        <span style={S.dayPill}>Today</span>
        <div style={S.bubble}>
          <p style={S.msg}>{text || 'Your message will appear here…'}</p>
          <span style={S.time}>now</span>
        </div>
      </div>
    </div>
  );
}

const S = {
  phone: {
    borderRadius: 18, overflow: 'hidden', background: '#fff',
    border: '1px solid rgba(146,64,94,0.12)', boxShadow: '0 4px 18px rgba(146,64,94,0.12)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 12px', borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#fff',
  },
  avatar: {
    width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg,#C76B8A,#92405e)', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14,
  },
  name: { fontSize: 14, fontWeight: 600, color: '#1d1b19', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  channel: { fontSize: 10, color: '#19a04b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: '50%', background: '#19a04b', display: 'inline-block' },
  body: { background: '#ECE5DD', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 90 },
  dayPill: { alignSelf: 'center', background: 'rgba(0,0,0,0.06)', color: '#5c5450', fontSize: 10, padding: '3px 10px', borderRadius: 8 },
  bubble: {
    alignSelf: 'flex-start', maxWidth: '85%', background: '#fff',
    borderRadius: '12px 12px 12px 3px', padding: '9px 11px', boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
  },
  msg: { margin: 0, fontSize: 13.5, lineHeight: 1.45, color: '#1d1b19', whiteSpace: 'pre-wrap' },
  time: { display: 'block', textAlign: 'right', fontSize: 9, color: '#9b938d', marginTop: 3 },
};
