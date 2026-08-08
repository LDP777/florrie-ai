/**
 * Toast Component
 *
 * Auto-dismissing notification
 * Variants: success (green), error (red), info (accent)
 * Slide-in animation from top
 */

import React, { useEffect, useState } from 'react';
import Icon, { iconName } from './Icon';

// Toast context for managing multiple toasts
let toastQueue = [];
let toastListeners = [];

const notifyToast = (message, variant = 'info', duration = 3000) => {
  const id = Date.now();
  toastQueue.push({ id, message, variant, duration });
  toastListeners.forEach(listener => listener([...toastQueue]));

  if (duration > 0) {
    setTimeout(() => {
      toastQueue = toastQueue.filter(t => t.id !== id);
      toastListeners.forEach(listener => listener([...toastQueue]));
    }, duration);
  }

  return id;
};

export const useToast = () => {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    toastListeners.push(setToasts);
    return () => {
      toastListeners = toastListeners.filter(l => l !== setToasts);
    };
  }, []);

  return {
    success: (msg, duration) => notifyToast(msg, 'success', duration),
    error: (msg, duration) => notifyToast(msg, 'error', duration),
    info: (msg, duration) => notifyToast(msg, 'info', duration),
    custom: (msg, variant, duration) => notifyToast(msg, variant, duration),
    toasts,
  };
};

/**
 * Toast component - renders a single toast
 */
const Toast = ({ id, message, variant = 'info', duration = 3000, onDismiss }) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setIsExiting(true);
        setTimeout(onDismiss, 200);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  const variantStyles = {
    success: {
      background: 'var(--success)',
      icon: 'check',
    },
    error: {
      background: 'var(--danger)',
      icon: 'x',
    },
    info: {
      background: 'var(--accent)',
      icon: 'info',
    },
  };

  const style = variantStyles[variant] || variantStyles.info;

  const toastStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: style.background,
    color: '#fff',
    padding: '12px 16px',
    borderRadius: 10,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    animation: isExiting
      ? 'slideOut 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      : 'slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards',
    minWidth: 200,
    maxWidth: 320,
  };

  return (
    <>
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateY(-100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        @keyframes slideOut {
          from {
            transform: translateY(0);
            opacity: 1;
          }
          to {
            transform: translateY(-100%);
            opacity: 0;
          }
        }
      `}</style>
      <div style={toastStyle}>
        <span style={{ fontSize: 18, lineHeight: 1 }}><Icon name={iconName(style.icon)} inline /></span>
        <span>{message}</span>
      </div>
    </>
  );
};

/**
 * ToastContainer - renders all active toasts
 * Mount this once at app root level
 */
export const ToastContainer = () => {
  const { toasts, ...toast } = useToast();

  const containerStyle = {
    position: 'fixed',
    top: 16,
    right: 16,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    pointerEvents: 'none',
  };

  return (
    <div style={containerStyle}>
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <Toast
            id={t.id}
            message={t.message}
            variant={t.variant}
            duration={t.duration}
            onDismiss={() => {
              toastQueue = toastQueue.filter(x => x.id !== t.id);
              toastListeners.forEach(listener => listener([...toastQueue]));
            }}
          />
        </div>
      ))}
    </div>
  );
};

export default Toast;
