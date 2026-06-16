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
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      launchFadeOutDuration: 300,
      backgroundColor: '#fef8f4',
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
      backgroundColor: '#fef8f4',
    },
  },
  ios: {
    scheme: 'Florrie',
    contentInset: 'always',
    preferredContentMode: 'mobile',
    backgroundColor: '#fef8f4',
  },
  android: {
    backgroundColor: '#fef8f4',
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
