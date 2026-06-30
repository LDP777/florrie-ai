/**
 * Toggle Component
 *
 * Accessible switch component (uses real checkbox, custom styled)
 * Role="switch" with aria-checked
 * Smooth transition animation
 */

import React from 'react';

const Toggle = ({ checked = false, onChange, label, disabled = false }) => {
  const toggleStyle = {
    display: 'flex',
    alignItems: 'center',
    minHeight: 44,
    gap: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };

  const switchContainerStyle = {
    position: 'relative',
    width: 44,
    height: 24,
    borderRadius: 12,
    background: checked ? 'var(--accent)' : 'var(--bg-hover)',
    transition: '0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    flexShrink: 0,
    border: 'none',
  };

  const dotStyle = {
    width: 20,
    height: 20,
    borderRadius: 10,
    background: '#fff',
    position: 'absolute',
    top: 2,
    left: checked ? 22 : 2,
    transition: '0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
  };

  const handleChange = (e) => {
    if (!disabled && onChange) {
      onChange(e.target.checked);
    }
  };

  return (
    <label style={toggleStyle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        style={{
          position: 'absolute',
          opacity: 0,
          width: 0,
          height: 0,
          cursor: 'inherit',
        }}
      />

      <div style={switchContainerStyle}>
        <div style={dotStyle} />
      </div>

      {label && (
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            userSelect: 'none',
          }}
        >
          {label}
        </span>
      )}
    </label>
  );
};

export default Toggle;
