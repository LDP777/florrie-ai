/** Shared by question routing and the no-reply gate: support takes priority. */
export function isBookingProblem(message) {
  const text = String(message || '').replace(/[’‘]/g, "'").toLowerCase();
  const verificationIssue = /\b(?:verification (?:email|code)|email (?:verification|code))\b/.test(text)
    && /\b(?:won'?t|can'?t|not|isn'?t|hasn'?t|failed|error|never|no)\b/.test(text);
  const bookingIssue = /\b(?:book(?:ing)?|booking system)\b/.test(text)
    && /\b(?:error|failed|not (?:letting|working)|won'?t (?:let|work)|can'?t (?:complete|finish))\b/.test(text);
  return verificationIssue || bookingIssue;
}
