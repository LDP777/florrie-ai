/**
 * HMRC Making Tax Digital (MTD) — Self-Assessment Integration.
 *
 * Florrie targets sole-trader beauticians. MTD for Income Tax Self-Assessment
 * (MTD ITSA) requires quarterly income/expense submissions from April 2026.
 *
 * This service:
 *   1. Builds quarterly summaries from Florrie's transactions + expenses tables
 *   2. Formats them for the HMRC MTD ITSA API
 *   3. Submits to HMRC sandbox (test) or production
 *   4. Stores submission records for audit trail
 *
 * API Reference: https://developer.service.hmrc.gov.uk/api-documentation/docs/api/service/self-assessment-api
 *
 * Registration process (Levi action):
 *   - Register as a software vendor: https://developer.service.hmrc.gov.uk/developer/registration
 *   - Apply for sandbox credentials (immediate)
 *   - Apply for production credentials (3-6 month review)
 *   - OAuth 2.0 for end-user authorization
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

const HMRC_BASE = process.env.HMRC_API_BASE || 'https://test-api.service.hmrc.gov.uk';
const HMRC_CLIENT_ID = process.env.HMRC_CLIENT_ID;
const HMRC_CLIENT_SECRET = process.env.HMRC_CLIENT_SECRET;

// UK tax year quarters for MTD ITSA
const TAX_QUARTERS = [
  { label: 'Q1', start: '04-06', end: '07-05' },   // 6 Apr – 5 Jul
  { label: 'Q2', start: '07-06', end: '10-05' },   // 6 Jul – 5 Oct
  { label: 'Q3', start: '10-06', end: '01-05' },   // 6 Oct – 5 Jan
  { label: 'Q4', start: '01-06', end: '04-05' },   // 6 Jan – 5 Apr
];

// HMRC category mapping from Florrie's expenses
const HMRC_EXPENSE_MAP = {
  cost_of_goods: 'costOfGoods',
  premises: 'premisesRunningCosts',
  admin: 'adminCosts',
  travel: 'travelCosts',
  advertising: 'advertisingCosts',
  professional_fees: 'professionalFees',
  insurance: 'insurance',
  interest: 'interest',
  phone: 'adminCosts',
  other_expenses: 'other',
};

/**
 * Build a quarterly summary for a beautician.
 * Pulls from transactions (income) and expenses (outgoings).
 */
export async function buildQuarterlySummary(beauticianId, taxYear, quarterIndex) {
  const quarter = TAX_QUARTERS[quarterIndex];
  if (!quarter) throw new Error(`Invalid quarter index: ${quarterIndex}`);

  // Calculate actual dates for this tax year
  const yearStart = parseInt(taxYear.split('-')[0]);
  const qStart = quarterIndex < 3
    ? `${yearStart}-${quarter.start}`
    : `${yearStart + 1}-${quarter.start}`;
  const qEnd = quarterIndex < 2
    ? `${yearStart}-${quarter.end}`
    : `${yearStart + 1}-${quarter.end}`;

  // Fetch income (completed appointments with payments)
  const { data: income } = await supabase
    .from('transactions')
    .select('amount_cents, type, created_at')
    .eq('beautician_id', beauticianId)
    .gte('created_at', `${qStart}T00:00:00Z`)
    .lte('created_at', `${qEnd}T23:59:59Z`)
    .eq('type', 'payment');

  // Fetch expenses grouped by HMRC category
  const { data: expenses } = await supabase
    .from('expenses')
    .select('amount_cents, hmrc_category, date')
    .eq('beautician_id', beauticianId)
    .gte('date', qStart)
    .lte('date', qEnd);

  // Aggregate income
  const totalIncome = (income || []).reduce((sum, t) => sum + (t.amount_cents || 0), 0);
  const turnover = totalIncome / 100; // Convert pence to pounds

  // Aggregate expenses by HMRC category
  const expensesByCategory = {};
  for (const exp of (expenses || [])) {
    const hmrcKey = HMRC_EXPENSE_MAP[exp.hmrc_category] || 'other';
    expensesByCategory[hmrcKey] = (expensesByCategory[hmrcKey] || 0) + (exp.amount_cents || 0);
  }

  // Convert to pounds
  const deductions = {};
  let totalDeductions = 0;
  for (const [key, pence] of Object.entries(expensesByCategory)) {
    const pounds = pence / 100;
    deductions[key] = pounds;
    totalDeductions += pounds;
  }

  return {
    taxYear,
    quarter: quarter.label,
    quarterIndex,
    periodStart: qStart,
    periodEnd: qEnd,
    income: {
      turnover,
      other: 0,
    },
    deductions,
    totals: {
      totalIncome: turnover,
      totalDeductions,
      netProfit: turnover - totalDeductions,
    },
    transactionCount: (income || []).length,
    expenseCount: (expenses || []).length,
  };
}

/**
 * Format quarterly summary for HMRC API submission.
 * Follows the Self-Assessment (MTD) Periodic Update schema.
 */
export function formatForHMRC(summary) {
  return {
    periodFromDate: summary.periodStart,
    periodToDate: summary.periodEnd,
    incomes: {
      turnover: {
        amount: summary.income.turnover,
      },
      other: {
        amount: summary.income.other,
      },
    },
    deductions: {
      costOfGoods: { amount: summary.deductions.costOfGoods || 0 },
      premisesRunningCosts: { amount: summary.deductions.premisesRunningCosts || 0 },
      adminCosts: { amount: summary.deductions.adminCosts || 0 },
      travelCosts: { amount: summary.deductions.travelCosts || 0 },
      advertisingCosts: { amount: summary.deductions.advertisingCosts || 0 },
      professionalFees: { amount: summary.deductions.professionalFees || 0 },
      insurance: { amount: summary.deductions.insurance || 0 },
      interest: { amount: summary.deductions.interest || 0 },
      other: { amount: summary.deductions.other || 0 },
    },
  };
}

/**
 * Submit a quarterly update to HMRC (sandbox or production).
 * Requires beautician to have completed HMRC OAuth authorisation.
 */
export async function submitQuarterlyUpdate(beauticianId, summary) {
  if (!HMRC_CLIENT_ID) {
    logger.warn('HMRC MTD not configured — skipping submission');
    return { success: false, reason: 'not_configured' };
  }

  // Get beautician's HMRC credentials
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('hmrc_access_token, hmrc_refresh_token, hmrc_nino')
    .eq('id', beauticianId)
    .single();

  if (!beautician?.hmrc_access_token || !beautician?.hmrc_nino) {
    return { success: false, reason: 'not_authorised', message: 'HMRC account not linked' };
  }

  const payload = formatForHMRC(summary);
  const nino = beautician.hmrc_nino;
  const businessId = 'default'; // Single business for sole traders

  try {
    const res = await fetch(
      `${HMRC_BASE}/individuals/business/self-employment/${nino}/${businessId}/period`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${beautician.hmrc_access_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.hmrc.2.0+json',
          'Gov-Test-Scenario': process.env.NODE_ENV === 'production' ? undefined : 'STATEFUL',
        },
        body: JSON.stringify(payload),
      }
    );

    const result = await res.json();

    // Store submission record
    await supabase.from('hmrc_submissions').insert({
      beautician_id: beauticianId,
      tax_year: summary.taxYear,
      quarter: summary.quarter,
      period_start: summary.periodStart,
      period_end: summary.periodEnd,
      payload,
      response: result,
      status: res.ok ? 'submitted' : 'failed',
      hmrc_status_code: res.status,
      submitted_at: new Date().toISOString(),
    });

    if (!res.ok) {
      logger.error({ status: res.status, result }, 'HMRC submission failed');
      return { success: false, reason: 'api_error', status: res.status, errors: result.errors };
    }

    logger.info({ beauticianId, quarter: summary.quarter }, 'HMRC quarterly update submitted');
    return { success: true, submissionId: result.id || result.periodId };
  } catch (err) {
    logger.error({ err }, 'HMRC submission request failed');
    return { success: false, reason: 'network_error', message: err.message };
  }
}

/**
 * HMRC OAuth 2.0 — generate authorisation URL.
 * Beautician clicks this to grant Florrie access to submit on their behalf.
 */
export function getHMRCAuthUrl(beauticianId, redirectUri) {
  const scope = 'write:self-assessment read:self-assessment';
  const state = Buffer.from(JSON.stringify({ beauticianId })).toString('base64url');

  return `${HMRC_BASE}/oauth/authorize?` +
    `client_id=${encodeURIComponent(HMRC_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&response_type=code` +
    `&state=${state}`;
}

/**
 * HMRC OAuth 2.0 — exchange auth code for tokens.
 */
export async function exchangeHMRCCode(code, redirectUri) {
  const res = await fetch(`${HMRC_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HMRC_CLIENT_ID,
      client_secret: HMRC_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`HMRC token exchange failed: ${err.error_description || err.error}`);
  }

  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}
