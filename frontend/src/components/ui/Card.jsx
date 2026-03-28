/**
 * Card Component
 *
 * Variants: default, elevated, outlined, gradient
 * Padding options: sm, md, lg
 * Optional header with title + action
 */

import React from 'react';

const Card = ({
  variant = 'default',
  padding = 'md',
  children,
  style,
  header,
  action,
}) => {
  const paddings = {
    sm: 12,
    md: 16,
    lg: 20,
  };

  const variants = {
    default: {
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-xs)',
    },
    elevated: {
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      boxShadow: 'var(--shadow-md)',
    },
    outlined: {
      background: 'transparent',
      border: '1px solid var(--border)',
      boxShadow: 'none',
    },
    gradient: {
      background: 'linear-gradient(135deg, #C76B8A 0%, #B85D7B 40%, #C9A96E 100%)',
      border: 'none',
      boxShadow: '0 8px 24px rgba(199, 107, 138, 0.2)',
      color: '#fff',
    },
  };

  const cardStyle = {
    borderRadius: 16,
    padding: paddings[padding],
    ...variants[variant],
    ...style,
  };

  return (
    <div style={cardStyle}>
      {header && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            paddingBottom: 12,
            borderBottom:
              variant === 'gradient' ? 'none' : '1px solid var(--border-light)',
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color:
                variant === 'gradient'
                  ? '#fff'
                  : 'var(--text-primary)',
            }}
          >
            {header}
          </h3>
          {action && <div>{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
};

export default Card;
