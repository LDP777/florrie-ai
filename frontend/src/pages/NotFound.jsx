import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-body)',
      background: 'var(--bg)',
      padding: '2rem',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{
          fontFamily: 'var(--font-display, Georgia)',
          fontSize: '4rem',
          color: 'var(--accent, #C76B8A)',
          fontWeight: 600,
          lineHeight: 1,
          marginBottom: 12,
        }}>
          404
        </div>
        <h2 style={{
          fontFamily: 'var(--font-display, Georgia)',
          fontSize: '1.4rem',
          color: 'var(--text-primary, #2D2A26)',
          marginBottom: 8,
        }}>
          Page not found
        </h2>
        <p style={{
          color: 'var(--text-secondary, #7A756F)',
          marginBottom: 24,
          lineHeight: 1.5,
        }}>
          The page you're looking for doesn't exist or has been moved.
        </p>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'var(--accent, #C76B8A)',
            color: '#fff',
            border: 'none',
            padding: '10px 28px',
            borderRadius: 'var(--radius-full, 999px)',
            fontSize: '0.95rem',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}
