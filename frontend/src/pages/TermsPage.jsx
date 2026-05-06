export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[720px] mx-auto">
        <a href="/" className="text-sm text-gray-400 hover:text-gray-600 mb-10 inline-block">&larr; Back to florrie.ai</a>
        <h1 className="text-4xl font-bold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>Terms of Service</h1>
        <p className="text-sm text-gray-400 mb-12">Last updated: May 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Who we are</h2>
            <p>Florrie is operated by <strong>FLORRIE.AI LTD</strong>, a private limited company registered in England and Wales (company number <strong>17141774</strong>), with registered office at 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN. References to "Florrie", "we", "us" or "our" mean FLORRIE.AI LTD. References to "you" mean the individual or business using our service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Using Florrie</h2>
            <p>By creating an account, you agree to use Florrie only for lawful business purposes. You are responsible for everything that happens under your account, including activity by any team members you add. You must be at least 18 years old to use Florrie.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Your data</h2>
            <p>You own your business data. We store it securely to power your Florrie experience and do not sell it to third parties. See our <a href="/privacy" className="text-pink-600 underline">Privacy Policy</a> for full details on how we handle your data.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. AI features</h2>
            <p>Florrie uses AI to automate messages, bookings, and business tasks on your behalf. You remain responsible for reviewing AI-generated content before it reaches your clients. We do not guarantee that AI responses will always be accurate or appropriate for your specific situation.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Messaging channels</h2>
            <p>If you connect a messaging channel (WhatsApp Business via Meta's WhatsApp Cloud API, SMS via Bird, or email via Resend) to your Florrie account, you authorise us to send and receive messages on your behalf through that channel. You remain the sender of record and are responsible for complying with the channel provider's terms, including Meta's WhatsApp Business Messaging Policy for WhatsApp.</p>
            <p>SMS messages sent on your behalf are transactional in nature: appointment confirmations, day-before reminders, rescheduling notices, and replies to client messages. Clients typically receive two to four SMS per booking. Clients can opt out of SMS at any time by replying <strong>STOP</strong>; replying <strong>HELP</strong> returns contact information. Standard message and data rates from the recipient's mobile carrier may apply. You can disconnect any messaging channel from Settings at any time.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Payments and billing</h2>
            <p>Florrie charges a monthly or annual subscription fee as shown on our pricing page. Payments are processed securely via Stripe. You can cancel at any time and your access continues until the end of your paid period. We do not offer refunds for partial months.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Fair use</h2>
            <p>Your plan includes 120 AI messages per month. Additional messages are charged at 10p each. We reserve the right to suspend accounts that misuse the service or use Florrie in ways that harm other users or third parties.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Availability</h2>
            <p>We aim to keep Florrie available 99.9% of the time but do not guarantee uninterrupted access. Scheduled maintenance will be communicated in advance where possible. We are not liable for losses caused by service interruptions.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Limitation of liability</h2>
            <p>Florrie is a tool to help you run your business more efficiently. We are not liable for business decisions you make based on information in Florrie, or for any indirect, incidental, or consequential losses. Our total liability to you in any 12-month period is capped at the fees you paid us in that period.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Changes to these terms</h2>
            <p>We may update these terms from time to time. If we make significant changes, we will notify you by email at least 14 days before they take effect. Continued use of Florrie after that date means you accept the updated terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">11. Governing law</h2>
            <p>These terms are governed by the laws of England and Wales. Any disputes will be resolved in the courts of England and Wales.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">12. Contact</h2>
            <p>Questions about these terms? Email us at <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a>.</p>
            <p className="text-sm text-gray-500 mt-4">FLORRIE.AI LTD, Company No. 17141774, registered office: 89 Pitcroft Avenue, Reading, United Kingdom, RG6 1NN.</p>
          </section>

        </div>
      </div>
    </div>
  );
}
