// The shared policy has no dependencies and also ships in the API's src-only image.
import { sentryPrivacyOptions, sentryBeforeSend } from '../../../backend/src/lib/sentry-privacy.js';

export function browserSentryOptions({ dsn, environment, integrations }) {
  return {
    dsn,
    environment,
    integrations,
    tracesSampleRate: 0.1,
    ...sentryPrivacyOptions,
    beforeSend(event, hint) {
      const error = hint?.originalException;
      const message = error?.message || event?.message || '';
      const name = error?.name || '';
      if (name === 'AbortError') return null;
      if (/Share canceled|Share cancelled|AbortError/i.test(message)) return null;
      if (/Script .*\/sw\.js.* load failed/i.test(message)) return null;
      if (/Maximum call stack size exceeded/i.test(message)) return null;
      if (/ResizeObserver loop|Loading chunk|Failed to fetch|NetworkError|Load failed/i.test(message)) return null;
      // Instagram/Facebook webviews inject scripts into public booking pages.
      if (/window\.webkit\.messageHandlers|_AutofillCallbackHandler|ceCurrentVideo\.currentTime/i.test(message)) return null;
      const frames = event?.exception?.values?.[0]?.stacktrace?.frames || [];
      if (frames.some(f => /sendDataToNative|sendPageHideMessage|sendMessageToNative/i.test(f?.function || ''))) return null;
      return sentryBeforeSend(event, hint);
    },
  };
}
