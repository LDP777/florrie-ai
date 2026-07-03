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
  '--bg': '#fef8f4',
  // Tonal layers (Aesop-style): structure from tone, not borders/shadows.
  // Trialled on Money first; roll out if it lands.
  '--tone-1': '#fbf1ea',
  '--tone-2': '#f6e7dd',
  '--bg-card': '#FFFFFF',
  '--bg-elevated': '#FFFFFF',
  '--bg-hover': '#f3ede9',
  '--bg-input': '#f8f2ef',
  '--bg-warm': '#f8f2ef',
  '--bg-subtle': '#ede7e3',

  // Stitch surface containers
  '--surface': '#fef8f4',
  '--surface-container-lowest': '#FFFFFF',
  '--surface-container-low': '#f8f2ef',
  '--surface-container': '#f3ede9',
  '--surface-container-high': '#ede7e3',
  '--surface-container-highest': '#e7e1de',

  // Text - Stitch on-surface
  '--text-primary': '#1d1b19',
  '--text-secondary': '#534247',
  '--text-muted': '#867277',
  '--text-inverse': '#FFFFFF',

  // Brand accent - Stitch primary (#92405e)
  '--accent': '#92405e',
  '--accent-hover': '#782b49',
  '--accent-light': '#ffd9e2',
  '--accent-bg': 'rgba(146, 64, 94, 0.08)',
  '--accent-text': '#3e001d',
  // Brand rose (the lighter end of the hero gradient) + the hero gradient itself
  '--accent-rose': '#c76b8a',
  '--gradient-hero': 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',

  // Primary scale
  '--primary-container': '#b05877',
  '--primary-fixed': '#ffd9e2',
  '--primary-fixed-dim': '#ffb1c8',

  // Gold - Stitch secondary (#745a27)
  '--gold': '#745a27',
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
  '--success': '#5BA97B',
  '--success-bg': '#EDF7F0',
  '--success-text': '#2D6B45',
  '--warning': '#D4943A',
  '--warning-bg': '#FEF5E7',
  '--warning-text': '#8B5E1A',
  '--danger': '#ba1a1a',
  '--danger-bg': '#ffdad6',
  '--danger-text': '#93000a',

  // Borders - Stitch outline
  '--border': '#d8c1c6',
  '--border-light': '#ede7e3',
  '--border-focus': 'rgba(146, 64, 94, 0.4)',
  '--outline': '#867277',
  '--outline-variant': '#d8c1c6',

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
  '--text-muted': '#867277',
  '--text-inverse': '#1d1b19',

  // Brand accent - Stitch inverse-primary
  '--accent': '#ffb1c8',
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
  '--success': '#6FCF97',
  '--success-bg': '#1A2A20',
  '--success-text': '#8EE0AE',
  '--warning': '#F2C94C',
  '--warning-bg': '#2A2418',
  '--warning-text': '#F5D76E',
  '--danger': '#EB5757',
  '--danger-bg': '#2A1A1A',
  '--danger-text': '#F08080',

  // Borders
  '--border': '#302E2C',
  '--border-light': '#242321',
  '--border-focus': 'rgba(255, 177, 200, 0.3)',
  '--outline': '#867277',
  '--outline-variant': '#534247',

  // Shadows
  '--shadow-xs': '0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.15)',
  '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.15)',
  '--shadow-glow': '0 0 0 3px rgba(255, 177, 200, 0.15)',
  '--shadow-gold': '0 0 0 3px rgba(228, 194, 133, 0.12)',
  '--shadow-editorial': '0 10px 30px rgba(0, 0, 0, 0.2)',

  // Nav
  '--nav-bg': 'rgba(30, 29, 27, 0.9)',
  '--nav-border': 'rgba(255, 177, 200, 0.1)',
  '--overlay': 'rgba(0, 0, 0, 0.45)',
};
