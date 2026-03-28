/**
 * EmptyState Component
 *
 * Centered layout with emoji/icon, title, description, and optional CTA button
 * Friendly, encouraging messaging
 */

import React from 'react';
import Button from './Button';

const EmptyState = ({
  emoji,
  title,
  description,
  actionLabel,
  onAction,
}) => {
  const containerStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '40px 20px',
    minHeight: 200,
    gap: 16,
  };

  const emojiStyle = {
    fontSize: 48,
    marginBottom: 8,
  };

  const titleStyle = {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  };

  const descriptionStyle = {
    fontSize: 14,
    color: 'var(--text-muted)',
    margin: 0,
    maxWidth: 320,
    lineHeight: 1.5,
  };

  return (
    <div style={containerStyle}>
      {emoji && <div style={emojiStyle}>{emoji}</div>}
      {title && <h2 style={titleStyle}>{title}</h2>}
      {description && <p style={descriptionStyle}>{description}</p>}
      {actionLabel && onAction && (
        <Button variant="primary" size="md" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

export default EmptyState;
