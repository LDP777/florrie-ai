/**
 * Optional product analytics are disabled until there is a reviewed opt-in
 * flow and a restricted event schema. Never load an SDK, identify an owner,
 * capture a page URL or record a session from these compatibility exports.
 * The diary and onboarding must work regardless of analytics configuration.
 */
export function initAnalytics() {}
export function track() {}
export function identify() {}
export function reset() {}
export function isFeatureEnabled() { return false; }
export function getFeatureFlag() { return null; }
