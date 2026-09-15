/** Public privacy notice. Keep provider and retention statements tied to the service. */
export default function PrivacyPolicy() {
  return (
    <div style={s.container}>
      <article style={s.article}>
        <h1 style={s.h1}>Privacy Policy</h1>
        <p style={s.meta}>Last updated: 15 September 2026</p>

        <section style={s.section}>
          <h2 style={s.h2}>Who we are</h2>
          <p style={s.p}><strong>FLORRIE.AI LTD</strong> provides Florrie, a booking and business management service for beauty professionals. Our company number is 17141774 and our registered office is 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN.</p>
          <p style={s.p}>We are responsible for the account, billing and support information we use to run Florrie. Your salon decides how it uses its client records and treatment information; we process those records on its behalf. Contact your salon about its treatment records, or contact us at <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a> for help with Florrie data.</p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Information Florrie handles</h2>
          <p style={s.p}>The information depends on which features and connections your salon uses. It comes from you, your salon, and services the salon connects.</p>
          <ul style={s.list}>
            <li>Names, contact details, business details, account identifiers and preferences.</li>
            <li>Bookings, attendance, treatment history, notes, patch-test records and consultation answers, including health information and signatures supplied for treatment preparation.</li>
            <li>Message content, attachments, sender and recipient identifiers, timestamps and delivery information from connected Instagram, WhatsApp, SMS and email channels.</li>
            <li>Photos, captions, content drafts, publishing instructions and the identifiers of published posts.</li>
            <li>Voice commands, transcripts and, when an audio feature is used, the audio supplied for processing.</li>
            <li>AI-generated drafts, client context, action records, corrections and writing-style preferences used within the salon’s account.</li>
            <li>Payment amounts, status and provider references. Stripe handles card details; Florrie does not store full card numbers.</li>
            <li>Connection credentials and technical information needed to authenticate users, operate the service and investigate errors.</li>
          </ul>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>How and why information is used</h2>
          <p style={s.p}>Florrie uses this information to manage bookings and payments, provide the inbox, prepare for appointments, send updates, draft or publish content, and carry out the salon’s instructions. It also supports account administration, fraud prevention, troubleshooting and service reliability.</p>
          <p style={s.p}>For our own account and billing operations, we use information to provide the service under our contract, meet applicable legal obligations, and pursue our legitimate interests in security and reliability. Where a feature relies on consent, that consent can be withdrawn. The salon is responsible for explaining its basis for processing client information, including the additional requirements for health information.</p>
          <p style={s.p}>We do not sell personal data. Information is shared with the providers needed to deliver the features below, and where legally required. Marketing messages need the relevant permission; providing a phone number for a booking is not permission for unrelated marketing.</p>
        </section>

        <section id="ai" style={s.section}>
          <h2 style={s.h2}>AI replies, voice and personalisation</h2>
          <p style={s.p}>Florrie uses Anthropic’s AI services to interpret requests, prepare replies and content, and work with business information. Relevant message text, conversation context, instructions, photos or other information supplied to the feature may be sent to that provider. Voice recognition can also use your device or browser provider’s speech service; transcripts are sent to Florrie, and an audio fallback may send the recording for processing.</p>
          <p style={s.p}>Personalisation is more than anonymous usage statistics. Florrie can build a writing-style profile from the salon’s own messages, keep example phrases, learn from saved corrections and use client context in future replies. These records belong to the salon’s account and are used in its AI instructions; they are not a separate AI model trained for that salon.</p>
          <p style={s.p}>Depending on the salon’s settings, replies may be drafted for review or sent automatically. AI can make mistakes. Clients can ask to speak to the salon, and the salon can review drafts, take over a conversation or change its reply settings. Do not rely on an AI reply as medical advice or confirmation that a treatment is safe.</p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Service providers</h2>
          <ul style={s.list}>
            <li><strong>Supabase:</strong> database, file storage and account authentication.</li>
            <li><strong>Railway and Vercel:</strong> application hosting and delivery.</li>
            <li><strong>Anthropic:</strong> AI processing for the features described above.</li>
            <li><strong>Meta:</strong> Instagram and WhatsApp account connections, messaging and Instagram publishing.</li>
            <li><strong>Bird and configured SMS providers:</strong> SMS delivery and receipt.</li>
            <li><strong>Resend:</strong> email delivery.</li>
            <li><strong>Stripe:</strong> payments, subscriptions and connected payout accounts.</li>
            <li><strong>Apple and Google:</strong> device notifications, sign-in or calendar features where used; your device or browser provider may also process speech recognition.</li>
            <li><strong>Sentry:</strong> error and performance reports used to investigate problems.</li>
            <li><strong>Connected accounting services:</strong> information the salon chooses to exchange with Xero or QuickBooks.</li>
          </ul>
          <p style={s.p}>Some providers process information outside the UK or EEA. Database hosting in one region does not mean all processing stays there. Contact us for details of the providers, processing locations and transfer arrangements relevant to your account.</p>
        </section>

        <section id="instagram" style={s.section}>
          <h2 style={s.h2}>Instagram</h2>
          <p style={s.p}>Connecting a professional Instagram account gives Florrie access to the permissions shown during Meta’s sign-in. We use account identifiers and profile details to connect the right salon, receive and reply to messages in its inbox, and publish content the salon approves or schedules. We store the connection token, conversation records and publishing results needed for these features.</p>
          <p style={s.p}>You can disconnect Instagram in Florrie’s Instagram settings. You can also remove Florrie in Instagram’s Apps and websites settings. Disconnecting stops Florrie using that connection; it does not automatically erase existing messages, bookings or learned context.</p>
          <p style={s.p}>To request removal of Instagram-derived data, use Instagram’s data-deletion option when removing the app, or email <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a> with your Instagram username and Florrie account email. A verified request from Meta receives a reference and status link. The request remains pending while we review and remove affected information; it is not marked complete just because the token has been cleared. See <a href="https://api.florrie.ai/api/instagram/privacy/data-deletion" style={s.link}>Instagram data request instructions</a>.</p>
        </section>

        <section id="whatsapp" style={s.section}>
          <h2 style={s.h2}>WhatsApp, SMS and email</h2>
          <p style={s.p}>Connected messaging services exchange client messages, confirmations, reminders and replies on the salon’s behalf. Florrie stores conversation and delivery records for the salon’s inbox and, where used, supplies relevant context to its AI features.</p>
          <p id="sms" style={s.p}>For SMS, clients can reply <strong>STOP</strong> to opt out or <strong>HELP</strong> for help. Message frequency depends on bookings and conversations. Mobile network charges may apply. Contact the salon if you want to change how it communicates with you.</p>
        </section>

        <section id="retention" style={s.section}>
          <h2 style={s.h2}>How long records are kept</h2>
          <p style={s.p}>Client records, conversations, completed consultation forms and saved AI context remain available while the salon uses them in its account, unless removed through a deletion process. A consultation link expiring does not delete a submitted treatment record. Expired, unsubmitted consultation answers are cleared by a scheduled cleanup.</p>
          <p style={s.p}>Retention depends on the purpose of the record, the salon’s instructions, payment-provider requirements and any applicable legal obligation or claim. A deletion request includes review of derived information such as writing examples and client context. Provider records and backups may have separate retention periods; disconnecting an account does not erase every copy immediately.</p>
        </section>

        <section id="delete" style={s.section}>
          <h2 style={s.h2}>Access, correction and deletion</h2>
          <p style={s.p}>To delete your Florrie account, use <strong>Settings → Account → Delete account</strong>, or email us from the address associated with your account. The app shows the progress of its cleanup. A request may need manual review of connected services before it can be completed. See <a href="/data-deletion" style={s.link}>data deletion instructions</a>.</p>
          <p style={s.p}>Clients can ask their salon to correct or delete their records, or contact us for help identifying the right account. We verify the request before disclosing or removing information. We respond to data-rights requests without undue delay, normally within one calendar month. If a lawful extension or exception applies, we explain it and any information that must be retained.</p>
          <p style={s.p}>Depending on the circumstances, you may ask for access, correction, deletion, restriction, portability, or object to processing. You can withdraw consent where we rely on it. Contact <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a>. You can also complain to the <a href="https://ico.org.uk/make-a-complaint/" style={s.link} target="_blank" rel="noopener noreferrer">Information Commissioner’s Office</a>.</p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Security and device storage</h2>
          <p style={s.p}>Florrie uses encrypted connections, authentication and access controls to protect account data. Contact us promptly if you suspect unauthorised access.</p>
          <p style={s.p}>The app uses device storage to keep you signed in and remember settings. Optional product analytics and session recording are disabled. Error and performance reporting helps us investigate failures. Services you visit for payments or account connections have their own privacy and storage notices.</p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Contact and updates</h2>
          <p style={s.p}>Email <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a>, or write to FLORRIE.AI LTD, 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN.</p>
          <p style={s.p}>We update this page when our practices change and make material changes available in the app or by email where appropriate.</p>
        </section>
      </article>
    </div>
  );
}

const s = {
  container: {
    padding: '20px 16px 40px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
  },
  article: {
    lineHeight: 1.6,
  },
  h1: {
    fontSize: 28,
    fontWeight: 700,
    color: 'var(--text, #241B17)',
    margin: '0 0 8px',
  },
  meta: {
    fontSize: 13,
    color: 'var(--text-muted, #6B5D54)',
    margin: '0 0 32px',
    fontStyle: 'italic',
  },
  section: {
    marginBottom: 32,
  },
  h2: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text, #241B17)',
    margin: '0 0 12px',
  },
  p: {
    fontSize: 15,
    color: 'var(--text-secondary, #574A42)',
    margin: '0 0 12px',
  },
  list: {
    fontSize: 15,
    color: 'var(--text-secondary, #574A42)',
    margin: '12px 0 16px',
    paddingLeft: 24,
  },
  link: {
    color: 'var(--accent, #92405e)',
    textDecoration: 'none',
    fontWeight: 500,
  },
};
