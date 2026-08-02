/**
 * Test environment.
 *
 * config.js builds the Supabase clients at import time, so importing anything
 * that eventually reaches it throws "supabaseUrl is required" before a single
 * assertion runs. Two test files were failing exactly that way, which is part
 * of why nobody noticed the suite could not be run with `npm test`.
 *
 * These are placeholders on purpose. Every unit test stubs the client it
 * needs. Nothing here should ever be able to reach a real service: if a test
 * starts making network calls, it should fail loudly on a nonsense URL rather
 * than quietly succeed against something real.
 */
process.env.NODE_ENV = 'test';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';

process.env.STRIPE_SECRET_KEY ||= 'sk_test_placeholder';
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
process.env.WHATSAPP_TOKEN ||= 'test-token';
process.env.WHATSAPP_WABA_ID ||= 'test-waba';

// Keep the suite output readable: pino would otherwise print a line per
// logger call from the modules under test.
process.env.LOG_LEVEL ||= 'silent';
