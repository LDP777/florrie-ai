export default function DataDeletionPage() {
  return (
    <div className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[720px] mx-auto">
        <a href="/" className="text-sm text-gray-400 hover:text-gray-600 mb-10 inline-block">&larr; Back to florrie.ai</a>
        <h1 className="text-4xl font-bold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>Data Deletion</h1>
        <p className="text-sm text-gray-400 mb-12">Last updated: May 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">How to delete your Florrie data</h2>
            <p>You can request deletion of your Florrie account and all associated data at any time. Under UK GDPR you have the right to erasure of your personal data, and we will action your request within 30 days.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Option 1: Delete from the app</h2>
            <p>If you are signed into Florrie, open Settings, scroll to the Account section, and tap Delete account. You will be asked to confirm. Once confirmed, your account and all associated business data will be queued for deletion.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Option 2: Email request</h2>
            <p>If you cannot sign into your account, or you prefer to request deletion by email, send a message to <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a> with the subject "Data deletion request" and include the email address associated with your Florrie account. We will verify the request and confirm deletion within 30 days.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">What gets deleted</h2>
            <p>When you request deletion, we permanently remove:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Your beautician account, login credentials, and profile information</li>
              <li>Your business details (name, address, brand, settings)</li>
              <li>All client records you have added to Florrie</li>
              <li>Appointment history, treatment records, and notes</li>
              <li>WhatsApp and SMS message history (both inbound and outbound)</li>
              <li>Payment records and Stripe customer references (subject to legal retention)</li>
              <li>WhatsApp Business Account links and stored access tokens</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">What we are required to keep</h2>
            <p>Some records must be retained for legal or regulatory reasons even after deletion. These include:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Financial transaction records, retained for 6 years for HMRC compliance</li>
              <li>Records that are subject to an active legal hold or regulatory investigation</li>
            </ul>
            <p className="mt-2">Where we retain data after deletion, it is anonymised or pseudonymised where possible and is not used for any operational purpose.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Deletion timeline</h2>
            <p>Most data is removed from active systems within 24 hours of your request. Backups are rotated and your data is fully purged within 30 days of deletion.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Questions</h2>
            <p>For any questions about data deletion or your rights under UK GDPR, contact us at <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a>.</p>
          </section>

        </div>
      </div>
    </div>
  );
}
