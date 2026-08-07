/**
 * Skeleton Component
 *
 * Shimmer loading placeholder
 * Variants: text (thin rectangle), card (rounded rectangle), circle (avatar)
 * CSS-only animation (no libraries)
 */

import React from 'react';

const Skeleton = ({
  variant = 'text',
  width = '100%',
  height,
  count = 1,
}) => {
  // Default heights for each variant
  const defaultHeights = {
    text: 12,
    card: 120,
    circle: 48,
  };

  const finalHeight = height || defaultHeights[variant];

  const skeletonStyle = {
    background: 'linear-gradient(90deg, var(--bg-hover) 0%, var(--bg-input) 50%, var(--bg-hover) 100%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 2s infinite',
    borderRadius: variant === 'circle' ? '50%' : variant === 'card' ? 12 : 4,
    width: variant === 'circle' ? finalHeight : width,
    height: finalHeight,
    marginBottom: count > 1 ? 8 : 0,
  };

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
      `}</style>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{ ...skeletonStyle,
            marginBottom: i === count - 1 ? 0 : 8,
          }}
        />
      ))}
    </>
  );
};

export default Skeleton;
