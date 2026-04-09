/**
 * Input Component
 *
 * Types: text, email, phone, time, number, textarea
 * Includes label, error state, helper text
 * Focus ring using accent color
 */

import React, { useState } from 'react';

const Input = ({
  label,
  type = 'text',
  error,
  helperText,
  placeholder,
  value,
  onChange,
  disabled = false,
  style,
  ...props
}) => {
  const [isFocused, setIsFocused] = useState(false);

  const isTextarea = type === 'textarea';

  const baseInputStyle = {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 12,
    border: error
      ? '1.5px solid var(--danger)'
      : isFocused
        ? '1.5px solid var(--accent)'
        : '1.5px solid var(--border)',
    fontSize: 14,
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    outline: 'none',
    boxSizing: 'border-box',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    transition: '0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: isFocused ? '0 0 0 3px rgba(199, 107, 138, 0.15)' : 'none',
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? 'not-allowed' : 'text',
    ...style,
  };

  const textareaStyle = {
    ...baseInputStyle,
    minHeight: 100,
    resize: 'vertical',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  };

  const inputStyle = isTextarea ? textareaStyle : baseInputStyle;

  return (
    <div style={{ width: '100%' }}>
      {label && (
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: error ? 'var(--danger)' : 'var(--text-secondary)',
            display: 'block',
            marginBottom: 6,
            letterSpacing: '0.01em',
          }}
        >
          {label}
        </label>
      )}

      {isTextarea ? (
        <textarea
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          style={inputStyle}
          {...props}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          style={inputStyle}
          {...props}
        />
      )}

      {error && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--danger)',
            margin: '6px 0 0 0',
            fontWeight: 500,
          }}
        >
          {error}
        </p>
      )}

      {helperText && !error && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            margin: '6px 0 0 0',
          }}
        >
          {helperText}
        </p>
      )}
    </div>
  );
};

export default Input;
