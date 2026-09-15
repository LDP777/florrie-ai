export default function DataDeletionPage() {
  return (
    <div className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[720px] mx-auto">
        <a href="/" className="text-sm text-gray-400 hover:text-gray-600 mb-10 inline-block">&larr; Back to florrie.ai</a>
        <h1 className="text-4xl font-bold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>Data Deletion</h1>
        <p className="text-sm text-gray-400 mb-12">Last updated: 15 September 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">How to delete your Florrie data</h2>
            <p>You can request deletion of your Florrie account and all associated data at any time. The right to erasure depends on the circumstances. We verify the request, review the affected records and explain any information that must be retained.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Option 1: Delete from the app</h2>
            <p>If you are signed into Florrie, open Settings, scroll to the Account section, and tap Delete account. You will be asked to confirm. Once confirmed, your account and all associated business data will be queued for deletion.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Option 2: Email request</h2>
            <p>If you cannot sign into your account, or you prefer to request deletion by email, send a message to <a href="mailto:hello@florrie.ai" className="text-pink-600 underline">hello@florrie.ai</a> with the subject "Data deletion request" and include the email address associated with your Florrie account. We will verify the request and respond without undue delay, normally within one calendar month. If a lawful extension or exception applies, we will explain it.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Instagram data only</h2>
            <p>Removing the Instagram connection does not delete your Florrie account. To request removal of Instagram-derived data, use Instagram’s data-deletion option when removing Florrie from Apps and websites, or email us with your Instagram username and Florrie account email. Verified Meta requests receive a status link and stay pending until cleanup is reviewed. <a href="https://api.florrie.ai/api/instagram/privacy/data-deletion" className="text-pink-600 underline">Read the Instagram instructions</a>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">What gets deleted</h2>
            <p>Account cleanup covers these records held by Florrie. The progress page stays pending if a step fails or a connected provider needs manual review:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Your beautician account, login credentials, and profile information</li>
              <li>Your business details (name, address, brand, settings)</li>
              <li>All client records you have added to Florrie</li>
              <li>Appointment history, treatment records, and notes</li>
              <li>Instagram, WhatsApp, SMS and email history, plus saved AI context and writing examples</li>
              <li>Payment records and Stripe customer references (subject to legal retention)</li>
              <li>Connected account links and stored credentials, with provider revocation checked separately</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">What we are required to keep</h2>
            <p>Some records must be retained for legal or regulatory reasons even after deletion. These include:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Financial records needed for applicable tax, accounting or payment-provider obligations</li>
              <li>Records that are subject to an active legal hold or regulatory investigation</li>
            </ul>
            <p className="mt-2">We will explain any retained records and their purpose. Payment providers and backups may keep separate records under their own retention requirements.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Deletion timeline</h2>
            <p>The app provides a reference and cleanup status. It only shows completion after its recorded steps succeed; a failed or unverified provider cleanup remains pending. A completion message does not mean that every provider or backup copy has been erased.</p>
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
