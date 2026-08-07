import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.florrie.app',
  appName: 'Florrie',
  webDir: 'dist',
  server: {
    // In dev, point to the Vite dev server for live reload
    // Comment out for production builds
    // url: 'http://192.168.1.x:5173',
    // cleartext: true,
    androidScheme: 'https',
  },
  plugins: {
    // The native chrome must be the brand cream. It was #fef8f4, the value
    // theme.jsx used to override the palette with, so once the web view renders
    // #FBF6F1 the splash, the status bar and the area behind the web view are a
    // different cream from the app: a visible seam at the top on iOS only, which
    // never shows up in a browser.
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      launchFadeOutDuration: 300,
      backgroundColor: '#FBF6F1',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#FBF6F1',
    },
  },
  ios: {
    scheme: 'Florrie',
    // 'always' made WKWebView add the notch inset NATIVELY on top of the
    // CSS env(safe-area-inset-top) padding (double top spacing), and let the
    // outer scroll view park scrolled-down, leaving a dead gap at the top of
    // Inbox/Money/Content. The CSS owns the safe area (viewport-fit=cover).
    contentInset: 'never',
    preferredContentMode: 'mobile',
    backgroundColor: '#FBF6F1',
  },
  android: {
    backgroundColor: '#FBF6F1',
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
