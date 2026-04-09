import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.florrie.app',
  appName: 'florrie.ai',
  webDir: 'dist',
  server: {
    // In dev, point to the Vite dev server for live reload
    // Comment out for production builds
    // url: 'http://192.168.1.x:5173',
    // cleartext: true,
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      launchFadeOutDuration: 300,
      backgroundColor: '#FAF8F5',
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
      style: 'LIGHT',
      backgroundColor: '#FAF8F5',
    },
  },
  ios: {
    scheme: 'florrie.ai',
    contentInset: 'always',
    preferredContentMode: 'mobile',
    backgroundColor: '#FAF8F5',
  },
  android: {
    backgroundColor: '#FAF8F5',
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
