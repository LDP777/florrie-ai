import { Component } from 'react';
import logger from '../lib/logger.js';
import { isNativeApp } from '../lib/platform.js';
import { isChunkLoadError, recoverMissingChunk } from '../lib/chunk-recovery.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    try {
      if (recoverMissingChunk({ error, native: isNativeApp(), storage: window.sessionStorage, reload: () => window.location.reload() })) return;
    } catch { /* The recovery button remains available if storage is blocked. */ }
    logger.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: 'var(--shell-viewport)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-body)',
          background: 'var(--bg)',
          padding: '2rem',
        }}>
          <div style={{ textAlign: 'center',
            maxWidth: 420,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #92405e)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 style={{ fontFamily: 'var(--font-display, Georgia)',
              fontSize: '1.5rem',
              color: 'var(--text-primary, #241B17)',
              marginBottom: 8,
            }}>
              {isChunkLoadError(this.state.error) ? "This page couldn’t load" : "Something went wrong"}
            </h2>
            <p style={{ color: 'var(--text-secondary, #574A42)',
              marginBottom: 24,
              lineHeight: 1.5,
            }}>
              {isChunkLoadError(this.state.error)
                ? "Florrie may have updated, or your connection was interrupted. Refresh to try again."
                : "We hit an unexpected error. Try refreshing the page."}
            </p>
            <button className="fl-tap"
              onClick={() => window.location.reload()}
              style={{ background: 'var(--accent, #92405e)',
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
