/**
 * Button Component
 *
 * Variants: primary, secondary, ghost, danger
 * Sizes: sm, md, lg
 * States: default, hover, active, disabled, loading
 */

import React from 'react';

const Button = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  onClick,
  children,
  style,
  fullWidth = false,
  ...props
}) => {
  // Base styles
  const base = {
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: '0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    gap: 8,
    position: 'relative',
    opacity: disabled ? 0.6 : 1,
    width: fullWidth ? '100%' : 'auto',
    ...(disabled && { pointerEvents: 'none' }),
  };

  // Size variants
  const sizes = {
    sm: {
      padding: '8px 12px',
      fontSize: 13,
      fontWeight: 500,
      borderRadius: 10,
    },
    md: {
      padding: '11px 16px',
      fontSize: 14,
      fontWeight: 600,
      borderRadius: 12,
    },
    lg: {
      padding: '14px 20px',
      fontSize: 15,
      fontWeight: 600,
      borderRadius: 14,
    },
  };

  // Variant styles
  const variants = {
    primary: {
      background: 'var(--accent)',
      color: '#fff',
      boxShadow: '0 2px 8px rgba(199, 107, 138, 0.25)',
      '&:hover': {
        background: 'var(--accent-hover)',
        boxShadow: '0 4px 12px rgba(199, 107, 138, 0.35)',
      },
      '&:active': {
        background: 'var(--accent-hover)',
        transform: 'scale(0.98)',
      },
      '&:focus': {
        outline: 'none',
        boxShadow: '0 0 0 3px rgba(199, 107, 138, 0.15)',
      },
    },
    secondary: {
      background: 'var(--bg-card)',
      color: 'var(--text-primary)',
      border: '1.5px solid var(--border)',
      '&:hover': {
        background: 'var(--bg-hover)',
        borderColor: 'var(--accent)',
      },
      '&:active': {
        transform: 'scale(0.98)',
      },
      '&:focus': {
        outline: 'none',
        boxShadow: '0 0 0 3px rgba(199, 107, 138, 0.15)',
      },
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      '&:hover': {
        background: 'var(--bg-hover)',
        color: 'var(--text-primary)',
      },
      '&:active': {
        transform: 'scale(0.98)',
      },
      '&:focus': {
        outline: 'none',
        boxShadow: '0 0 0 3px rgba(199, 107, 138, 0.15)',
      },
    },
    danger: {
      background: 'var(--danger)',
      color: '#fff',
      boxShadow: '0 2px 8px rgba(212, 96, 92, 0.25)',
      '&:hover': {
        boxShadow: '0 4px 12px rgba(212, 96, 92, 0.35)',
        filter: 'brightness(1.1)',
      },
      '&:active': {
        transform: 'scale(0.98)',
      },
      '&:focus': {
        outline: 'none',
        boxShadow: '0 0 0 3px rgba(212, 96, 92, 0.15)',
      },
    },
  };

  const buttonStyle = {
    ...base,
    ...sizes[size],
    ...variants[variant],
    ...style,
  };

  const handleClick = (e) => {
    if (!disabled && !loading && onClick) {
      onClick(e);
    }
  };

  return (
    <button
      style={buttonStyle}
      onClick={handleClick}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner size={size === 'lg' ? 18 : 14} />}
      {children}
    </button>
  );
};

/**
 * Simple CSS spinner for loading state
 */
const Spinner = ({ size = 14 }) => {
  const spinnerStyle = {
    width: size,
    height: size,
    border: `2px solid currentColor`,
    borderRightColor: 'transparent',
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
  };

  return (
    <>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={spinnerStyle} />
    </>
  );
};

export default Button;
