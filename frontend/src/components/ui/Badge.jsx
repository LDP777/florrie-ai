/**
 * Badge Component
 *
 * Variants: default, success, warning, danger, info
 * Sizes: sm, md
 * Pill shape
 */

import React from 'react';

const Badge = ({
  variant = 'default',
  size = 'md',
  children,
  style,
}) => {
  const sizes = {
    sm: {
      fontSize: 11,
      padding: '3px 8px',
    },
    md: {
      fontSize: 12,
      padding: '6px 12px',
    },
  };

  const variants = {
    default: {
      background: 'var(--bg-hover)',
      color: 'var(--text-secondary)',
    },
    success: {
      background: 'var(--success-bg)',
      color: 'var(--success-text)',
    },
    warning: {
      background: 'var(--warning-bg)',
      color: 'var(--warning-text)',
    },
    danger: {
      background: 'var(--danger-bg)',
      color: 'var(--danger-text)',
    },
    info: {
      background: 'var(--accent-light)',
      color: 'var(--accent-text)',
    },
  };

  const badgeStyle = {
    display: 'inline-block',
    borderRadius: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    ...sizes[size],
    ...variants[variant],
    ...style,
  };

  return <span style={badgeStyle}>{children}</span>;
};

export default Badge;
