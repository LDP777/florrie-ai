// Keep v1 content stable: provider retries use the same idempotency key.
export function waitlistWelcomeEmail(token) {
  if (!/^[0-9a-f-]{36}$/i.test(token || '')) throw new Error('Invalid welcome unsubscribe token');
  const unsubscribe = `https://api.florrie.ai/api/waitlist/unsubscribe?token=${token}`;
  const serif = "'Instrument Serif',Georgia,'Times New Roman',serif";
  const sans = "'Instrument Sans',Arial,sans-serif";
  return {
    subject: 'You’re on the list 🌸 Welcome to Florrie',
    headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    text: `You’re on the list. Welcome to Florrie.

A little less admin. A little more you.

Thanks for joining us. Florrie is being built for the messages, bookings and little jobs that follow you home after your last client.

You’re on our launch list. We’ll email you when Florrie is ready to welcome you, with a few product updates along the way. There’s nothing else you need to do.

Take a look at Florrie: https://florrie.ai/landing.html#demo

See you soon,
The Florrie team

Got a question? Reply to this email and it will reach Levi at levi@florrie.ai.

You received this because you joined the Florrie launch list.
Unsubscribe: ${unsubscribe}
Privacy: https://florrie.ai/privacy`,
    html: `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Welcome to Florrie</title>
<style>@font-face{font-family:'Instrument Serif';font-weight:400;src:url('https://florrie.ai/florrie-landing/fonts/instrument-serif-latin-400-normal.woff2')}@font-face{font-family:'Instrument Sans';font-weight:400;src:url('https://florrie.ai/florrie-landing/fonts/instrument-sans-latin-400-normal.woff2')}@media(max-width:480px){.email-pad{padding:32px 24px!important}.email-title{font-size:42px!important;line-height:1.08!important}}a:focus-visible{outline:3px solid #a34d6c;outline-offset:4px}</style></head>
<body style="margin:0;padding:0;background:#f4eae3;color:#30272a;font-family:${sans}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">A little hello from Florrie. Your place on our launch list is saved.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4eae3"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:#fffcf9;border:1px solid #e7d8d2;border-radius:26px;overflow:hidden">
<tr><td align="center" style="padding:32px 24px 26px;border-bottom:1px solid #eee2dc"><img src="https://florrie.ai/favicon-192.png" width="52" height="52" alt="Florrie flower" style="display:block;border:0;border-radius:16px;margin-bottom:12px"><span style="font-family:${serif};font-size:32px;letter-spacing:-1px;color:#91405f">florrie.ai</span></td></tr>
<tr><td class="email-pad" style="padding:40px 42px 36px">
<p style="margin:0 0 18px;font-size:11px;font-weight:bold;letter-spacing:2px;color:#91405f;text-transform:uppercase">You’re on the list</p>
<h1 class="email-title" style="margin:0 0 24px;font-family:${serif};font-size:52px;line-height:1.08;font-weight:400;letter-spacing:-1px">A little less admin.<br><span style="color:#91405f;font-style:italic">A little more you.</span></h1>
<p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#5a4d46">Thanks for joining us. Florrie is being built for the messages, bookings and little jobs that follow you home after your last client.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:26px 0;background:#f8eee9;border-radius:16px"><tr><td style="padding:22px 24px;border-left:3px solid #c26784">
<p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:#30272a">We’ll be in touch.</p>
<p style="margin:0;font-size:15px;line-height:1.65;color:#5a4d46">We’ll email you when Florrie is ready to welcome you, with a few product updates along the way. There’s nothing else you need to do.</p></td></tr></table>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#91405f" style="border-radius:28px"><a href="https://florrie.ai/landing.html#demo" style="display:inline-block;padding:16px 26px;border:1px solid #91405f;border-radius:28px;color:#ffffff;text-decoration:none;font-family:${sans};font-size:15px;font-weight:bold">Take a look at Florrie&nbsp; →</a></td></tr></table>
<p style="margin:30px 0 0;font-size:15px;line-height:1.7;color:#5a4d46">See you soon,<br><span style="font-family:${serif};font-size:25px;color:#91405f">The Florrie team</span></p>
</td></tr>
<tr><td style="padding:24px 28px;background:#f8f1ec;border-top:1px solid #eee2dc;text-align:center">
<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#65564f">Got a question? Just reply.<br>Your email will reach Levi at <a href="mailto:levi@florrie.ai" style="color:#91405f">levi@florrie.ai</a>.</p>
<p style="margin:0 0 12px;font-size:11px;line-height:1.6;color:#75655d">You received this because you joined the Florrie launch list.</p>
<p style="margin:0;font-size:12px;line-height:1.6"><a href="${unsubscribe}" style="color:#65564f;text-decoration:underline">Unsubscribe</a>&nbsp; · &nbsp;<a href="https://florrie.ai/privacy" style="color:#65564f;text-decoration:underline">Privacy policy</a></p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
