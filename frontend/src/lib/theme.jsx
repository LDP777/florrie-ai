/**
 * Florrie Theme System v2
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
  // Backgrounds
  '--bg': '#FAF8F5',
  '--bg-card': '#FFFFFF',
  '--bg-elevated': '#FFFFFF',
  '--bg-hover': '#F5F2EF',
  '--bg-input': '#FAF8F5',
  '--bg-warm': '#FFF9F6',
  '--bg-subtle': '#F7F4F0',

  // Text
  '--text-primary': '#2D2A26',
  '--text-secondary': '#7A756F',
  '--text-muted': '#B5AFA8',
  '--text-inverse': '#FFFFFF',

  // Brand accent — dusty rose
  '--accent': '#C76B8A',
  '--accent-hover': '#B85D7B',
  '--accent-light': '#FFF0F3',
  '--accent-bg': '#FBF0F3',
  '--accent-text': '#9E4A67',

  // Gold — premium accent
  '--gold': '#C9A96E',
  '--gold-hover': '#B89A60',
  '--gold-light': '#FDF8EE',
  '--gold-bg': 'rgba(201, 169, 110, 0.08)',
  '--gold-text': '#8A7245',

  // Semantic
  '--success': '#5BA97B',
  '--success-bg': '#EDF7F0',
  '--success-text': '#2D6B45',
  '--warning': '#D4943A',
  '--warning-bg': '#FEF5E7',
  '--warning-text': '#8B5E1A',
  '--danger': '#D4605C',
  '--danger-bg': '#FDF0EF',
  '--danger-text': '#8B2F2C',

  // Borders
  '--border': '#EDE9E4',
  '--border-light': '#F5F2EF',
  '--border-focus': 'rgba(199, 107, 138, 0.4)',

  // Shadows
  '--shadow-xs': '0 1px 2px rgba(45, 42, 38, 0.04)',
  '--shadow-sm': '0 1px 3px rgba(45, 42, 38, 0.06), 0 1px 2px rgba(45, 42, 38, 0.04)',
  '--shadow-md': '0 4px 12px rgba(45, 42, 38, 0.06), 0 1px 3px rgba(45, 42, 38, 0.04)',
  '--shadow-lg': '0 8px 24px rgba(45, 42, 38, 0.08), 0 2px 6px rgba(45, 42, 38, 0.04)',
  '--shadow-glow': '0 0 0 3px rgba(199, 107, 138, 0.1)',
  '--shadow-gold': '0 0 0 3px rgba(201, 169, 110, 0.1)',

  // Nav
  '--nav-bg': '#FFFFFF',
  '--nav-border': '#EDE9E4',
  '--overlay': 'rgba(45, 42, 38, 0.18)',
};

const darkTokens = {
  // Backgrounds
  '--bg': '#161514',
  '--bg-card': '#1E1D1B',
  '--bg-elevated': '#262523',
  '--bg-hover': '#2E2D2B',
  '--bg-input': '#1E1D1B',
  '--bg-warm': '#1A1918',
  '--bg-subtle': '#1A1918',

  // Text
  '--text-primary': '#F2EFEB',
  '--text-secondary': '#A09B95',
  '--text-muted': '#6A655F',
  '--text-inverse': '#161514',

  // Brand accent — lighter rose for dark bg
  '--accent': '#D88FA6',
  '--accent-hover': '#E0A0B5',
  '--accent-light': '#2A1E23',
  '--accent-bg': '#2A1E23',
  '--accent-text': '#E8B5C5',

  // Gold
  '--gold': '#D4B87E',
  '--gold-hover': '#E0C890',
  '--gold-light': '#252018',
  '--gold-bg': 'rgba(212, 184, 126, 0.08)',
  '--gold-text': '#E0C890',

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
  '--border-focus': 'rgba(216, 143, 166, 0.3)',

  // Shadows
  '--shadow-xs': '0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15)',
  '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.15)',
  '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.15)',
  '--shadow-glow': '0 0 0 3px rgba(216, 143, 166, 0.15)',
  '--shadow-gold': '0 0 0 3px rgba(212, 184, 126, 0.12)',

  // Nav
  '--nav-bg': '#1E1D1B',
  '--nav-border': '#302E2C',
  '--overlay': 'rgba(0, 0, 0, 0.45)',
};
