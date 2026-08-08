/**
 * florrie.ai Theme System v2
 *
 * Extended CSS-variable system with Soft Luxury palette.
 * Light + Dark modes. Gold accent for premium touches.
 *
 * Usage:
 *   const { isDark, toggle } = useTheme();
 *   <div style={{ background: 'var(--bg)' }}>
 */

import { useState, useEffect, createContext, useContext } from 'react';

const ThemeContext = createContext({ isDark: false, toggle: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    applyTheme(isDark);
  }, [isDark]);

  function toggle() {
    setIsDark(prev => !prev);
  }

  return (
    <ThemeContext.Provider value={{ isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(dark) {
  const root = document.documentElement;
  const vars = dark ? darkTokens : lightTokens;
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

const lightTokens = {
  // Backgrounds - Stitch surface scale
  '--bg': '#FBF6F1',            // brand cream
  // Tonal layers (Aesop-style): structure from tone, not borders/shadows.
  // Trialled on Money first; roll out if it lands.
  '--tone-1': '#fbf1ea',
  '--tone-2': '#f6e7dd',
  '--bg-card': '#FFFCF9',       // a lift off cream, never stark white
  '--bg-elevated': '#FFFCF9',
  '--bg-hover': '#f3ede9',
  '--bg-input': '#F4EDE6',        // the one sunken surface
  '--bg-warm': '#f8f2ef',
  '--bg-subtle': '#ede7e3',

  // Stitch surface containers
  '--surface': '#FBF6F1',
  '--surface-container-lowest': '#FFFCF9',
  '--surface-container-low': '#f8f2ef',
  '--surface-container': '#f3ede9',
  '--surface-container-high': '#ede7e3',
  '--surface-container-highest': '#e7e1de',

  // Text - Stitch on-surface
  '--text-primary': '#241B17',  // brand ink
  '--text-secondary': '#574A42',
  '--text-muted': '#6B5D54',    // was 4.48:1, failed AA on every real surface
  '--text-inverse': '#FFFFFF',

  // Brand accent - Stitch primary (#92405e)
  '--accent': '#92405e',
  // The colour of text ON the accent, which is not a constant. In light mode
  // the accent is a deep maroon and white sits on it correctly. In dark mode
  // the accent inverts to a light rose and white on it measures 1.7:1 — the
  // single cause of 57 unreadable text nodes across the app, because every
  // rule that paints on the accent hardcoded #fff.
  '--on-accent': '#ffffff',
  '--on-danger': '#ffffff',
  '--accent-hover': '#782b49',
  '--accent-light': '#F6E7EC',  // rose wash, not bubblegum
  '--accent-bg': 'rgba(146, 64, 94, 0.08)',
  '--accent-text': '#3e001d',
  // Brand rose (the lighter end of the hero gradient) + the hero gradient itself
  '--accent-rose': '#c76b8a',
  '--gradient-hero': 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',

  // Primary scale
  '--primary-container': '#b05877',
  '--primary-fixed': '#F6E7EC',
  '--primary-fixed-dim': '#ffb1c8',

  // Gold - Stitch secondary (#745a27)
  '--gold': '#8A6420',          // readable gold, 4.98:1 on cream
  '--gold-fill': '#C9A96E',     // brand gold: fills and rules only, never text or icons
  '--gold-hover': '#5a4312',
  '--gold-light': '#ffdea4',
  '--gold-bg': 'rgba(116, 90, 39, 0.1)',
  '--gold-text': '#795f2b',

  // Secondary container
  '--secondary-container': '#fedb9b',

  // Tertiary
  '--tertiary': '#685950',
  '--tertiary-fixed': '#f3dfd3',

  // Semantic
  // Brand-tinted semantics. The old values were stock Material defaults
  // (#4caf50 / #f44336 / #2196f3) sitting next to brand tones.
  '--success': '#3F7D5C',
  '--success-bg': '#E9F0EB',
  '--success-text': '#3F7D5C',
  '--warning': '#8A6420',
  '--warning-bg': '#F7EEDD',
  '--warning-text': '#8A6420',
  '--danger': '#9E2B32',
  '--danger-bg': '#F7E4E4',
  '--danger-text': '#9E2B32',

  // Borders - Stitch outline
  '--border': '#E8DDD4',          // was a pink-grey, so every rule read mauve
  '--border-light': '#ede7e3',
  '--border-focus': 'rgba(146, 64, 94, 0.4)',
  '--outline': '#6B5D54',
  '--outline-variant': '#E8DDD4',

  // Shadows - rose-tinted editorial
  '--shadow-xs': '0 1px 2px rgba(146, 64, 94, 0.04)',
  '--shadow-sm': '0 1px 3px rgba(146, 64, 94, 0.06), 0 1px 2px rgba(146, 64, 94, 0.04)',
  '--shadow-md': '0 4px 12px rgba(146, 64, 94, 0.06), 0 1px 3px rgba(146, 64, 94, 0.04)',
  '--shadow-lg': '0 8px 24px rgba(146, 64, 94, 0.08), 0 2px 6px rgba(146, 64, 94, 0.04)',
  '--shadow-glow': '0 0 0 3px rgba(146, 64, 94, 0.1)',
  '--shadow-gold': '0 0 0 3px rgba(116, 90, 39, 0.1)',
  '--shadow-editorial': '0 10px 30px rgba(146, 64, 94, 0.06)',

  // Nav - glass morphism
  '--nav-bg': 'rgba(254, 248, 244, 0.9)',
  '--nav-border': 'rgba(146, 64, 94, 0.1)',
// Aliases. These names are used across the app but were never defined, so every
  // call site was rendering its own hardcoded fallback and dark mode could not invert.
  '--text': '#241B17',
  '--card': '#FFFCF9',
  '--card-bg': '#FFFCF9',
  '--card-border': '#E8DDD4',
  '--accent-wash': '#FBF2F5',
  '--accent-dark': '#782b49',
  '--primary': '#92405e',
  '--bg-secondary': '#f8f2ef',
  '--surface-2': '#f3ede9',
  '--info': '#4A6C82',
  '--info-bg': '#EAF0F4',
  '--danger-light': '#F7E4E4',
  '--danger-border': '#EFCFCF',
  '--overlay': 'rgba(29, 27, 25, 0.18)',
};


const darkTokens = {
  // Backgrounds - Stitch inverse
  '--bg': '#161514',
  '--tone-1': '#1E1D1B',
  '--tone-2': '#262523',
  '--bg-card': '#1E1D1B',
  '--bg-elevated': '#262523',
  '--bg-hover': '#2E2D2B',
  '--bg-input': '#1E1D1B',
  '--bg-warm': '#1A1918',
  '--bg-subtle': '#1A1918',

  // Surface containers (dark)
  '--surface': '#161514',
  '--surface-container-lowest': '#111010',
  '--surface-container-low': '#1A1918',
  '--surface-container': '#1E1D1B',
  '--surface-container-high': '#262523',
  '--surface-container-highest': '#32302e',

  // Text - Stitch inverse-on-surface
  '--text-primary': '#f5f0ec',
  '--text-secondary': '#d6c3b7',
  '--text-muted': '#a89890',
  '--text-inverse': '#1d1b19',

  // Brand accent - Stitch inverse-primary
  '--accent': '#ffb1c8',
  // Dark ink on the light rose. Measures 11.6:1, where white measured 1.7:1.
  '--on-accent': '#241B17',
  '--on-danger': '#241B17',
  '--accent-hover': '#ffd9e2',
  '--accent-light': '#3e001d',
  '--accent-bg': 'rgba(255, 177, 200, 0.08)',
  '--accent-text': '#ffd9e2',
  // Brand rose + hero gradient stay on-brand in dark mode (rose on rose).
  '--accent-rose': '#c76b8a',
  '--gradient-hero': 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',

  // Primary scale (dark)
  '--primary-container': '#b05877',
  '--primary-fixed': '#ffd9e2',
  '--primary-fixed-dim': '#ffb1c8',

  // Gold - secondary for dark
  '--gold': '#e4c285',
  '--gold-hover': '#fedb9b',
  '--gold-light': '#261900',
  '--gold-bg': 'rgba(228, 194, 133, 0.08)',
  '--gold-text': '#fedb9b',

  '--secondary-container': '#5a4312',
  '--tertiary': '#d6c3b7',
  '--tertiary-fixed': '#51443c',

  // Semantic
  '--success': '#7FC79E',
  '--success-bg': '#1B2A22',
  '--success-text': '#9BD8B4',
  '--warning': '#DCB463',
  '--warning-bg': '#2A2418',
  '--warning-text': '#E8C87F',
  '--danger': '#E07A7A',
  '--danger-bg': '#2A1A1A',
  '--danger-text': '#EE9A9A',

  // Borders
  '--border': '#302E2C',
  '--border-light': '#242321',
  '--border-focus': 'rgba(255, 177, 200, 0.3)',
  '--outline': '#a89890',
  '--outline-variant': '#534247',

  // Shadows
  '--shadow-xs': '0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.15)',
  '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.15)',
  '--shadow-glow': '0 0 0 3px rgba(255, 177, 200, 0.15)',
  '--shadow-gold': '0 0 0 3px rgba(228, 194, 133, 0.12)',
  '--shadow-editorial': '0 10px 30px rgba(0, 0, 0, 0.2)',

// Aliases (see light map)
  '--text': '#f5f0ec',
  '--card': '#1E1D1B',
  '--card-bg': '#1E1D1B',
  '--card-border': '#302E2C',
  '--accent-wash': '#2A1620',
  '--accent-dark': '#ffd9e2',
  '--primary': '#ffb1c8',
  '--bg-secondary': '#1A1918',
  '--surface-2': '#1E1D1B',
  '--info': '#8FB4C9',
  '--info-bg': '#18222A',
  '--danger-light': '#2A1A1A',
  '--danger-border': '#4A2A2A',
  '--gold-fill': '#C9A96E',

  // Nav
  '--nav-bg': 'rgba(30, 29, 27, 0.9)',
  '--nav-border': 'rgba(255, 177, 200, 0.1)',
  '--overlay': 'rgba(0, 0, 0, 0.45)',
};
