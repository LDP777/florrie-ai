export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[720px] mx-auto">
        <a href="/" className="text-sm text-gray-400 hover:text-gray-600 mb-10 inline-block">&larr; Back to florrie.ai</a>
        <h1 className="text-4xl font-bold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>Privacy Policy</h1>
        <p className="text-sm text-gray-400 mb-12">Last updated: April 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Who we are</h2>
            <p>Florrie Ltd operates florrie.ai. This policy explains what personal data we collect, how we use it, and your rights under UK GDPR. If you have questions, contact us at <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Data we collect</h2>
            <p><strong>Account data:</strong> your name, email address, and business details when you sign up.</p>
            <p className="mt-2"><strong>Business data:</strong> client records, appointment history, messages, and financial information you enter into Florrie.</p>
            <p className="mt-2"><strong>Usage data:</strong> how you use the app, feature interactions, and error logs to help us improve the product.</p>
            <p className="mt-2"><strong>Payment data:</strong> handled directly by Stripe. We do not store your card details.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. How we use your data</h2>
            <p>We use your data to provide and improve the Florrie service, process payments, send service communications (such as receipts and account notices), and comply with legal obligations. We do not use your data for advertising or sell it to third parties.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Your clients' data</h2>
            <p>When you use Florrie to manage your clients, you are the data controller for their personal information. We process it on your behalf as a data processor. You are responsible for having an appropriate lawful basis for processing your clients' data and for informing them that you use Florrie to manage their records.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. AI processing</h2>
            <p>Florrie uses AI models to power features like message replies, booking suggestions, and business insights. Your data may be processed by these models to generate responses. We do not use your data to train third-party AI models.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Data storage and security</h2>
            <p>Your data is stored securely in the UK and EU using Supabase (PostgreSQL with row-level security). We use encryption at rest and in transit, access controls, and regular security reviews. No system is 100% secure, but we take reasonable steps to protect your information.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. How long we keep your data</h2>
            <p>We keep your account and business data for as long as your account is active. If you close your account, we delete your data within 90 days, except where we are required to keep it for legal or regulatory reasons.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Third-party services</h2>
            <p>Florrie integrates with third-party services including Stripe (payments), Supabase (database), Meta (WhatsApp Business Cloud API for messaging), Bird (SMS), and Resend (email). Each has its own privacy policy. We only share data with these services to the extent necessary to operate Florrie.</p>
          </section>

          <section id="whatsapp">
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. WhatsApp Business messaging</h2>
            <p>When a beautician connects their WhatsApp Business Account to Florrie, we exchange messages with their clients on their behalf using Meta's WhatsApp Business Cloud API:</p>
            <p className="mt-2"><strong>Inbound:</strong> we receive client messages (text, media, voice notes) forwarded from Meta's servers to api.florrie.ai.</p>
            <p className="mt-2"><strong>Outbound:</strong> we send confirmations, reminders, and replies drafted by the beautician or the Florrie AI.</p>
            <p className="mt-2"><strong>Storage:</strong> message content, timestamps, and phone numbers are stored in our EU-hosted Supabase database for conversation history and AI context.</p>
            <p className="mt-2"><strong>Retention:</strong> messages are retained for the life of the beautician's account. On account deletion we purge all message content within 30 days.</p>
            <p className="mt-2"><strong>Sharing:</strong> we never sell WhatsApp data, never share message content with any third party except the infrastructure providers named above, and never use WhatsApp data to train models owned by anyone other than the beautician's own account.</p>
            <p className="mt-2"><strong>Control:</strong> the beautician can disconnect at any time from Settings → WhatsApp, which revokes the sharing permission and stops message ingestion immediately.</p>
          </section>

          <section id="delete">
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Data deletion</h2>
            <p>To delete your account and all associated data (including WhatsApp message history), email <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a> with the subject line "Delete my account". We confirm within 24 hours, revoke third-party tokens (Meta WhatsApp, Stripe, Bird) within 72 hours, and purge all personal data within 30 days. Clients of beauticians on Florrie can also request deletion of their own records by contacting the beautician or emailing us directly.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">11. Your rights</h2>
            <p>Under UK GDPR, you have the right to access, correct, or delete your personal data, restrict or object to processing, and request a portable copy of your data. To exercise any of these rights, email <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a>. We will respond within 30 days.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">12. Cookies</h2>
            <p>We use essential cookies to keep you logged in and remember your preferences. We do not use advertising cookies or sell data to ad networks.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">13. Changes to this policy</h2>
            <p>We may update this policy from time to time. Material changes will be communicated by email before they take effect.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">14. Contact and complaints</h2>
            <p>For privacy questions, email <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a>. If you are unhappy with how we handle your data, you have the right to lodge a complaint with the ICO (ico.org.uk).</p>
          </section>

        </div>
      </div>
    </div>
  );
}
