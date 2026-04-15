import { Component } from 'react';
import logger from '../lib/logger.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    logger.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
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
          <div style={{
            textAlign: 'center',
            maxWidth: 420,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #C76B8A)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 style={{
              fontFamily: 'var(--font-display, Georgia)',
              fontSize: '1.5rem',
              color: 'var(--text-primary, #2D2A26)',
              marginBottom: 8,
            }}>
              Something went wrong
            </h2>
            <p style={{
              color: 'var(--text-secondary, #7A756F)',
              marginBottom: 24,
              lineHeight: 1.5,
            }}>
              We hit an unexpected error. Try refreshing the page.
            </p>
            <button
              onClick={() => window.location.reload()}
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
              Refresh page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
