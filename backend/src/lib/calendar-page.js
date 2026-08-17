/**
 * The page a client lands on when she taps "add to your calendar".
 *
 * Self-contained HTML, served by the API, with no Florrie session and no app
 * shell — because of where the link is tapped from.
 *
 * A bare .ics link works in two of the three places it gets sent:
 *
 *   email  — iOS Mail and Gmail both render an .ics ATTACHMENT as a one-tap
 *            banner. Best path, and it needs no page at all.
 *   SMS    — Messages hands a link to real Safari, and Safari with
 *            `Content-Type: text/calendar` + `Content-Disposition: attachment`
 *            shows the add-to-calendar sheet. Confirmed behaviour.
 *   WhatsApp — opens links in its OWN WKWebView. Downloading a file there
 *            needs the host app to implement WKDownloadDelegate (iOS 15+),
 *            and when it does not the tap does NOTHING AT ALL. No error, no
 *            sheet, no file. Which is worse than the problem we set out to
 *            fix, because at least searching your inbox eventually works.
 *
 * So the link in a message goes here, not straight at the file. This page
 * renders fine in every webview, offers the .ics and a Google Calendar link,
 * and — when it can tell it is inside an in-app browser — says so at the top
 * and explains the one gesture that gets out of it. Telling somebody how to
 * succeed beats a button that quietly does nothing.
 *
 * No client notes, no prices, no phone number. This URL is guarded only by an
 * unguessable token and gets forwarded.
 */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function calendarLandingPage({
  treatmentName, businessName, whenLabel, icsUrl, googleUrl, manageUrl, brand = '#92405E',
}) {
  const title = esc([treatmentName, businessName && `at ${businessName}`].filter(Boolean).join(' '));
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Add to your calendar</title>
</head>
<body style="margin:0;min-height:100vh;background:#FBF6F1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#241B17;-webkit-text-size-adjust:100%">
<div style="max-width:26rem;margin:0 auto;padding:2rem 1.25rem 3rem">

  <div id="inapp" style="display:none;background:#F7EEDD;color:#79581C;border-radius:14px;padding:.9rem 1rem;margin-bottom:1.25rem;font-size:.9rem;line-height:1.55">
    You're in <span id="appname">this app</span>'s browser, which can't save calendar files.
    Tap the <strong>&#8943;</strong> or <strong>share</strong> button and choose
    <strong>Open in Safari</strong> first, then tap the button below.
  </div>

  <p style="margin:0 0 .35rem;font-size:.7rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#6B5D54">Your appointment</p>
  <h1 style="margin:0 0 .3rem;font-size:1.35rem;line-height:1.3;font-weight:700">${title}</h1>
  <p style="margin:0 0 1.75rem;font-size:1.05rem;color:#574A42">${esc(whenLabel)}</p>

  <a href="${esc(icsUrl)}"
     style="display:block;text-align:center;box-sizing:border-box;width:100%;padding:1rem;border-radius:14px;background:${esc(brand)};color:#fff;text-decoration:none;font-size:1rem;font-weight:700">
    Add to Apple Calendar
  </a>
  <p style="margin:.6rem 0 1.5rem;font-size:.8rem;line-height:1.5;color:#6B5D54;text-align:center">
    It'll remind you the evening before and an hour ahead.
  </p>

  <a href="${esc(googleUrl)}"
     style="display:block;text-align:center;box-sizing:border-box;width:100%;padding:.9rem;border-radius:14px;background:transparent;border:1.5px solid #E8DDD4;color:#241B17;text-decoration:none;font-size:.95rem;font-weight:600">
    Add to Google Calendar
  </a>

  ${manageUrl ? `<p style="margin:1.75rem 0 0;text-align:center;font-size:.85rem">
    <a href="${esc(manageUrl)}" style="color:${esc(brand)}">Change or cancel this booking</a>
  </p>` : ''}
</div>
<script>
// Named so the notice can say which app she is actually in — "you're in
// WhatsApp's browser" is a sentence somebody acts on; "your browser may not
// support this" is one they ignore.
(function () {
  var ua = navigator.userAgent || '';
  var app = /WhatsApp/i.test(ua) ? 'WhatsApp'
    : /Instagram/i.test(ua) ? 'Instagram'
    : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'Facebook'
    : /Messenger/i.test(ua) ? 'Messenger'
    : null;
  if (!app) return;
  document.getElementById('appname').textContent = app;
  document.getElementById('inapp').style.display = 'block';
})();
</script>
</body></html>`;
}
