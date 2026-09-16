/**
 * Shared, dependency-free Sentry export policy for the API and browser.
 * This lives under backend/src because the API Docker image copies only src.
 * Diagnostics are allowlisted: redacting named keys alone misses customer text
 * echoed by provider errors, SQL errors, console breadcrumbs and span data.
 */
const FILTERED = '[Filtered]';
const SAFE_MESSAGES = new Set([
  'Application fee refund failed',
  'Assumed takings not superseded: delete failed',
  'Assumed takings not superseded: read failed',
  'Assumed takings not superseded: reduce failed',
  'Booking confirmed and the owner was told nothing',
  'Booking hold left in the diary after a failed checkout',
  'CHARGED BUT NOT MARKED: policy fee idempotency anchor not written',
  'CHARGED BUT NOT RECORDED: manual card charge',
  'CHARGED BUT NOT RECORDED: policy fee',
  'CHARGED BUT NOT RECORDED: remaining balance',
  'Card payment disputed by a client',
  'Checkout session created with no payment intent',
  'Deposit booking fell through to the confirmed-immediately tail',
  'Deposit not logged: guard unreadable',
  'Failed charge still counted as income',
  'Failed policy fee left locked as already_charged',
  'Failed policy fee left locked: appointment unreadable',
  'Florrie subscription payment failed',
  'Health check degraded',
  'Instagram token dead, reconnection required',
  'PAID BUT NOT RECORDED: booking deposit',
  'PAID BUT NOT RECORDED: webhook deposit',
  'Past booking cleared: its deposit was never payable',
  'Payment intent not pinned to a deposit booking',
  'REFUNDED BUT NOT RECORDED',
  'Reconciliation could not complete',
  'Reconciliation found money mismatches',
  'Refund not recorded: guard unreadable',
  'Refund not recorded: no matching payment row',
  'Refund: appointment deposit status not cleared',
  'Reschedule deposit failed after the appointment was marked paid',
  'Resent deposit left pointing at the stale payment intent',
  'Resent deposit session created with no payment intent',
  'Stale booking cleanup held: payment news is not arriving',
  'Stale cleanup found a paid deposit recorded as unpaid',
  'Stripe rejected the conversational booking Checkout expiry',
  'Stripe webhook signature verification failed',
  'Subscription webhook could not read the plan',
  'Takings lost: auto-complete transaction insert failed',
  'Takings lost: complete-day could not log every appointment',
  'Takings lost: completion transaction insert failed',
  'Takings not logged: guard unreadable',
  'WhatsApp WABA at phone-number capacity, beautician blocked',
  'meta-templates create failed',
  'meta-templates delete failed',
  'meta-templates list failed',
]);

const CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DIAGNOSTIC_CODES = new Set(['area', 'check', 'origin', 'op', 'job', 'jobName', 'stage', 'status', 'method', 'code', 'source', 'kind', 'eventType']);
const DIAGNOSTIC_IDS = new Set(['appointmentId', 'beauticianId', 'transactionId']);
const COUNTER = /^(?:count|counts|total|attemptCount|graceMinutes|retryGraceMinutes|wouldHaveCancelled|takingsPence|feeCents|amountCents|amountDue|moneyAtStripeNotRecorded|recordedButNotAtStripe|completedWithNoTakings|failed|succeeded|duration_ms|status_code|http\.response\.status_code)$/;

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string' && CODE.test(value)) result[key] = value;
  }
  return result;
}

// Remove every query value and fragment, not just today's known token names.
// Booking links and consultation links also carry bearer credentials in paths.
export function sentrySafeUrl(value) {
  if (typeof value !== 'string') return FILTERED;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const url = new URL(value, 'https://florrie.invalid');
    if (!['http:', 'https:', 'capacitor:', 'app:'].includes(url.protocol)) return FILTERED;
    const path = url.pathname
      .replace(/\/(?:storage|object)\/.*$/i, '/[Filtered]')
      .replace(/(\/(?:manage|consultation|forms?|public|feed|reset-password|confirm|deletion-status|data-deletion-status)\/)[^/]+/gi, '$1[Filtered]')
      .split('/').map(part => {
        if (part.startsWith(':') && /^:[a-zA-Z][\w]*$/.test(part)) return part;
        if (/%|@/.test(part) || UUID.test(part) || /^\d+$/.test(part) || /^[A-Za-z0-9_-]{24,}$/.test(part)) return FILTERED;
        return part;
      }).join('/');
    return `${absolute ? `${url.protocol}//${url.host}` : ''}${path}`;
  } catch { return FILTERED; }
}

function diagnosticMessage(value) {
  if (typeof value !== 'string') return FILTERED;
  const title = value.replace(/\s+\u2014\s+/g, ', ');
  if (SAFE_MESSAGES.has(title)) return title;
  // Keep useful engine/database failure classes, never their interpolated data.
  const common = /^(Cannot read properties of (?:undefined|null)|Cannot convert undefined or null to object|Maximum call stack size exceeded|Failed to fetch|Load failed|NetworkError|duplicate key value violates unique constraint|new row violates row-level security policy|invalid input syntax for type|canceling statement due to statement timeout)(?:$|[ :.(])/i.exec(value);
  return common ? common[1] : FILTERED;
}

function diagnosticFields(source) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (DIAGNOSTIC_CODES.has(key) && typeof value === 'string' && CODE.test(value)) result[key] = value;
    else if (DIAGNOSTIC_IDS.has(key) && typeof value === 'string' && UUID.test(value)) result[key] = value;
    else if (COUNTER.test(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

function stacktrace(source) {
  if (!Array.isArray(source?.frames)) return undefined;
  return { frames: source.frames.filter(frame => frame && typeof frame === 'object').map(frame => {
    const clean = pick(frame, ['lineno', 'colno', 'in_app', 'native', 'platform']);
    // Function names and code locations identify the failure without locals,
    // source context, function arguments or serialized Error objects.
    if (typeof frame.function === 'string' && /^[\w.$<> ()\[\]-]{1,160}$/.test(frame.function)) clean.function = frame.function;
    for (const key of ['filename', 'abs_path']) {
      if (typeof frame[key] === 'string') {
        clean[key] = sentrySafeUrl(frame[key].replace(/\/(?:Users|home)\/[^/]+\//g, '/[home]/'));
      }
    }
    return clean;
  }) };
}

export function sentryBeforeBreadcrumb(crumb) {
  const clean = pick(crumb, ['category', 'type', 'level', 'timestamp']);
  const data = pick(crumb?.data, ['method', 'status_code', 'http.response.status_code']);
  for (const key of ['url', 'from', 'to']) {
    if (typeof crumb?.data?.[key] === 'string') data[key] = sentrySafeUrl(crumb.data[key]);
  }
  clean.data = data;
  // Console arguments and DOM selectors can contain client names and text.
  if (crumb?.message) clean.message = diagnosticMessage(crumb.message);
  return clean;
}

function measurements(source) {
  const clean = {};
  for (const [key, measurement] of Object.entries(source || {})) {
    if (/^(?:cls|fcp|fid|inp|lcp|ttfb|fp)(?:\.[a-z_]+)?$/.test(key)) clean[key] = pick(measurement, ['value', 'unit']);
  }
  return clean;
}

export function sentryBeforeSendSpan(span) {
  const clean = pick(span, ['trace_id', 'span_id', 'parent_span_id', 'start_timestamp', 'timestamp', 'op', 'status', 'origin', 'exclusive_time', 'is_segment']);
  if (span?.measurements) clean.measurements = measurements(span.measurements);
  clean.data = pick(span?.data, ['http.request.method', 'http.response.status_code', 'status_code']);
  for (const key of ['url', 'http.url']) {
    if (typeof span?.data?.[key] === 'string') clean.data[key] = sentrySafeUrl(span.data[key]);
  }
  // Database/AI descriptions can include SQL values, prompts and replies.
  if (span?.op?.startsWith('http') && typeof span.description === 'string') {
    const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (.+)$/.exec(span.description);
    if (match) clean.description = `${match[1]} ${sentrySafeUrl(match[2])}`;
  }
  return clean;
}

export function sentryBeforeSend(event, hint) {
  // Attachments are separate envelope items, not part of the event object.
  if (hint?.attachments) hint.attachments = [];
  const clean = pick(event, ['event_id', 'timestamp', 'start_timestamp', 'level', 'platform', 'release', 'dist', 'environment', 'type']);
  if (typeof event?.release === 'string' && /^[a-zA-Z0-9_.@+-]{1,200}$/.test(event.release)) clean.release = event.release;
  if (event?.message) clean.message = diagnosticMessage(event.message);
  if (event?.logentry) clean.logentry = { message: diagnosticMessage(event.logentry.message) };
  clean.tags = diagnosticFields(event?.tags);
  clean.extra = diagnosticFields(event?.extra);
  if (event?.request) {
    clean.request = pick(event.request, ['method']);
    if (event.request.url) clean.request.url = sentrySafeUrl(event.request.url);
  }
  if (Array.isArray(event?.exception?.values)) {
    clean.exception = { values: event.exception.values.filter(error => error && typeof error === 'object').map(error => ({
      ...pick(error, ['type', 'module']),
      value: diagnosticMessage(error.value),
      ...(error.stacktrace ? { stacktrace: stacktrace(error.stacktrace) } : {}),
      ...(error.mechanism ? { mechanism: pick(error.mechanism, ['type', 'handled', 'synthetic', 'exception_id', 'parent_id']) } : {}),
    })) };
  }
  if (event?.stacktrace) clean.stacktrace = stacktrace(event.stacktrace);
  if (Array.isArray(event?.breadcrumbs)) clean.breadcrumbs = event.breadcrumbs.map(sentryBeforeBreadcrumb);
  clean.contexts = {};
  for (const name of ['browser', 'os', 'runtime', 'app', 'device']) {
    if (event?.contexts?.[name]) clean.contexts[name] = pick(event.contexts[name], ['name', 'version', 'build', 'app_version', 'app_build', 'family', 'model', 'arch', 'brand', 'screen_width_pixels', 'screen_height_pixels', 'memory_size']);
  }
  if (event?.contexts?.trace) clean.contexts.trace = sentryBeforeSendSpan(event.contexts.trace);
  if (event?.transaction) {
    const match = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?(\/.*)$/.exec(event.transaction);
    clean.transaction = match ? `${match[1] ? `${match[1]} ` : ''}${sentrySafeUrl(match[2])}` : FILTERED;
  }
  if (Array.isArray(event?.spans)) clean.spans = event.spans.map(sentryBeforeSendSpan);
  if (event?.measurements) clean.measurements = measurements(event.measurements);
  // An allowlist also excludes user, request cookies/body/query/env, arbitrary
  // contexts, error cause/extras, fingerprint text and SDK truncation originals.
  return clean;
}

export const sentryPrivacyOptions = {
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
  beforeSendSpan: sentryBeforeSendSpan,
  beforeBreadcrumb: sentryBeforeBreadcrumb,
};
