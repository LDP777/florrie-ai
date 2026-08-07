import { useTheme } from '../lib/theme.jsx';

/**
 * Privacy Policy. Explains how Florrie handles user data.
 * Route: /privacy
 */
export default function PrivacyPolicy() {
  const { dark } = useTheme();

  return (
    <div style={s.container}>
      <article style={s.article}>
        <h1 style={s.h1}>Privacy Policy</h1>
        <p style={s.meta}>Last updated: May 2026</p>

        <section style={s.section}>
          <h2 style={s.h2}>Who we are</h2>
          <p style={s.p}>
            <strong>FLORRIE.AI LTD</strong> (company number 17141774, registered in England and Wales, registered office: 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN) is the Data Controller for the personal data we collect through florrie.ai. References to "Florrie", "we", "us" or "our" mean FLORRIE.AI LTD.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>What data we collect</h2>
          <p style={s.p}>
            Florrie collects the following information to provide our booking and salon management services:
          </p>
          <ul style={s.list}>
            <li>Your name, phone number, and email address</li>
            <li>Appointment history and treatment preferences</li>
            <li>Payment information (processed securely by Stripe; we never store card details)</li>
            <li>Messages sent through our SMS, WhatsApp, and email systems</li>
            <li>Optional: photos for treatment progress tracking (with your consent)</li>
          </ul>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>How we use your data</h2>
          <p style={s.p}>
            We use your information only to provide the Florrie service:
          </p>
          <ul style={s.list}>
            <li>Manage your appointments and booking information</li>
            <li>Send appointment reminders and updates</li>
            <li>Process payments securely</li>
            <li>Improve our service (anonymised usage patterns only)</li>
          </ul>
          <p style={s.p}>
            We never sell or share your personal data with third parties. We don't use your data for marketing without your explicit consent.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Third parties we trust</h2>
          <p style={s.p}>
            To operate Florrie, we use the following services with your data:
          </p>
          <ul style={s.list}>
            <li><strong>Supabase.</strong> Database hosting and user authentication (EU servers).</li>
            <li><strong>Stripe.</strong> Secure payment processing (PCI DSS Level 1 compliant).</li>
            <li><strong>Bird.</strong> SMS delivery for appointment reminders and two-way messaging.</li>
            <li><strong>Meta (WhatsApp Business Cloud API).</strong> Delivery and receipt of WhatsApp messages between beauticians and their clients.</li>
            <li><strong>Resend.</strong> Transactional email delivery.</li>
          </ul>
          <p style={s.p}>
            All these partners are contractually obligated to protect your data and use it only as needed to provide their services.
          </p>
        </section>

        <section id="sms" style={s.section}>
          <h2 style={s.h2}>SMS messaging</h2>
          <p style={s.p}>
            When a beautician on Florrie has SMS enabled, we send transactional messages to clients on the beautician's behalf using Bird as our carrier:
          </p>
          <ul style={s.list}>
            <li>Clients are added to SMS only when they provide their phone number to book or be booked by their beautician. The opt-in is captured at the point of booking.</li>
            <li>Typical message frequency is two to four SMS per booking: confirmation, day-before reminder, any rescheduling, and replies to client messages.</li>
            <li>Clients can opt out at any time by replying <strong>STOP</strong>. Replying <strong>HELP</strong> returns contact information.</li>
            <li>Standard message and data rates from the client's mobile carrier may apply.</li>
            <li>SMS content (message body, timestamps, sender and recipient numbers) is stored in our EU-hosted Supabase database for the life of the beautician's account, then purged within 30 days of account deletion.</li>
            <li>We never sell SMS data and never share message content with any third party except Bird (the carrier delivering the message) and the infrastructure providers named above.</li>
          </ul>
        </section>

        <section id="whatsapp" style={s.section}>
          <h2 style={s.h2}>WhatsApp Business messaging</h2>
          <p style={s.p}>
            When a beautician connects their WhatsApp Business Account to Florrie, we exchange messages with their clients on their behalf using Meta's WhatsApp Business Cloud API. Specifically:
          </p>
          <ul style={s.list}>
            <li>We receive inbound client messages (text, media, voice notes) forwarded from Meta's servers to our backend.</li>
            <li>We send outbound messages (appointment confirmations, reminders, replies drafted by the beautician or the Florrie AI) via the Cloud API.</li>
            <li>We store message content, timestamps, and phone numbers in our EU-hosted Supabase database so beauticians can review conversation history and so the AI can produce contextually relevant replies.</li>
            <li>We retain messages for the life of the beautician's account. On account deletion, we purge all message content within 30 days.</li>
            <li>We never sell WhatsApp data. We never share WhatsApp message content with any third party except the infrastructure providers named above. We never use WhatsApp data to train models owned by anyone other than the beautician's own account.</li>
            <li>The beautician can disconnect at any time from Settings &rarr; WhatsApp, which revokes the sharing permission and stops message ingestion immediately.</li>
          </ul>
        </section>

        <section id="delete" style={s.section}>
          <h2 style={s.h2}>Data deletion</h2>
          <p style={s.p}>
            To delete your account and all associated data (including SMS and WhatsApp message history), email <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a> with the subject line "Delete my account". We will:
          </p>
          <ul style={s.list}>
            <li>Confirm the request from the email address on your account within 24 hours.</li>
            <li>Revoke all third-party tokens (Meta WhatsApp, Stripe, Bird) within 72 hours of confirmation.</li>
            <li>Purge all personal data and message content from our database within 30 days.</li>
            <li>Send you a final confirmation when deletion is complete.</li>
          </ul>
          <p style={s.p}>
            Clients of beauticians on Florrie can also request deletion of their own records. Contact the beautician directly or email us.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Your data rights (UK GDPR)</h2>
          <p style={s.p}>
            If you're in the UK or EU, you have rights under UK GDPR / EU GDPR:
          </p>
          <ul style={s.list}>
            <li><strong>Access:</strong> Request a copy of all data we hold about you.</li>
            <li><strong>Correction:</strong> Ask us to fix incorrect information.</li>
            <li><strong>Deletion:</strong> Request we delete your data (right to be forgotten).</li>
            <li><strong>Portability:</strong> Get your data in a machine-readable format.</li>
            <li><strong>Objection:</strong> Opt out of processing for certain purposes.</li>
          </ul>
          <p style={s.p}>
            Contact us at <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a> to exercise any of these rights.
          </p>
          <p style={s.p}>
            You also have the right to lodge a complaint with the UK Information Commissioner's Office (ICO) at <a href="https://ico.org.uk" style={s.link} target="_blank" rel="noopener noreferrer">ico.org.uk</a>.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Data security</h2>
          <p style={s.p}>
            We take security seriously. Your data is encrypted in transit (HTTPS) and at rest. We regularly audit our systems and comply with industry best practices.
          </p>
          <p style={s.p}>
            In the event of a personal data breach that affects your rights and freedoms, we will notify the UK Information Commissioner's Office within 72 hours of becoming aware of it, and notify affected users without undue delay where required.
          </p>
          <p style={s.p}>
            However, no system is 100% secure. If you believe your data has been compromised, contact us immediately at <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a>.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Cookies</h2>
          <p style={s.p}>
            We use essential cookies only, to keep you logged in and remember your preferences. We don't use tracking or advertising cookies.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Changes to this policy</h2>
          <p style={s.p}>
            We may update this privacy policy as our service evolves. We'll notify you of any material changes by email or on this page.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Contact us</h2>
          <p style={s.p}>
            Questions about our privacy practices? Get in touch:
          </p>
          <p style={s.p}>
            Email: <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a>
          </p>
          <p style={s.p}>
            Post: FLORRIE.AI LTD, 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN
          </p>
          <p style={s.p}>
            We're here to help.
          </p>
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
    color: 'var(--text, #2D2A26)',
    margin: '0 0 8px',
  },
  meta: {
    fontSize: 13,
    color: 'var(--text-muted, #B5AFA8)',
    margin: '0 0 32px',
    fontStyle: 'italic',
  },
  section: {
    marginBottom: 32,
  },
  h2: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
    margin: '0 0 12px',
  },
  p: {
    fontSize: 15,
    color: 'var(--text-secondary, #7A756F)',
    margin: '0 0 12px',
  },
  list: {
    fontSize: 15,
    color: 'var(--text-secondary, #7A756F)',
    margin: '12px 0 16px',
    paddingLeft: 24,
  },
  link: {
    color: 'var(--accent, #C76B8A)',
    textDecoration: 'none',
    fontWeight: 500,
  },
};
