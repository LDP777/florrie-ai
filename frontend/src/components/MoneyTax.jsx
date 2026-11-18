import Icon from './ui/Icon.jsx';
import Button from './ui/Button.jsx';
import { PrivateAmount, useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import { formatMoney as fmt } from '../lib/money-view.js';

const S = {
  card: { background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 22, padding: 20, marginBottom: 16 },
  title: { fontFamily: 'var(--font-display)', fontStyle: 'italic', fontWeight: 400, color: 'var(--accent)', fontSize: 21, margin: '0 0 12px' },
  text: { fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '8px 0' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--border-light)', fontSize: 14 },
  amount: { fontFamily: 'var(--font-body)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  summary: { minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--accent)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' },
};
function MoneyLine({ label, value, strong = false }) {
  return <div style={S.row}><span style={{ minWidth: 0, fontWeight: strong ? 600 : 400 }}>{label}</span><span style={{ ...S.amount, color: strong ? 'var(--accent)' : 'inherit' }}><PrivateAmount>{fmt(value)}</PrivateAmount></span></div>;
}

function TaxDetails({ title, children, warning = false, nested = false }) {
  return <details className="money-tax-details" style={nested ? undefined : { ...S.card, padding: '4px 18px', ...(warning ? { background: 'var(--warning-bg)' } : {}) }}>
    <summary style={{ ...S.summary, ...(warning ? { color: 'var(--text-primary)' } : {}) }}><span>{title}</span><Icon name="chevron-down" size={16} /></summary>
    <div style={{ paddingBottom: nested ? 0 : 10 }}>{children}</div>
  </details>;
}

export function MoneyTax({ report: t, years, onYear, onExport, exporting, onSettings, onReview }) {
  const { hidden } = useClientPrivacy();
  const needsChecking = t.assumedCount + t.reviewCount;
  const date = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return <section aria-label="Tax summary">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
      <h2 style={{ ...S.title, margin: 0 }}>Your tax year</h2>
      <select aria-label="Tax year" value={t.taxYear} onChange={e => onYear(e.target.value)} style={{ minHeight: 44, maxWidth: '50%', border: '1px solid var(--border-light)', borderRadius: 12, padding: '8px 12px', font: 'inherit', fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-card)' }}>{years.map(y => <option key={y} value={y}>{y.replace('-', '/')}</option>)}</select>
    </div>
    <p style={{ ...S.text, margin: '0 0 18px', fontSize: 12 }}>{date(t.period.start)} to {date(t.period.end)}</p>
    <section aria-label="Tax year figures" style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
      <div style={{ background: 'var(--gradient-hero)', color: '#fff', padding: '24px 22px' }}>
        <p style={{ margin: '0 0 10px', fontSize: 13 }}>Income after costs</p>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(29px, 8vw, 40px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.025em', overflowWrap: 'anywhere' }}><PrivateAmount>{fmt(t.taxableProfit)}</PrivateAmount></div>
        <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5 }}>From the payments and deductible costs recorded below.</p>
      </div>
      <div style={{ padding: '6px 22px 14px' }}>
        <MoneyLine label="Money received" value={t.totalIncome} />
        <MoneyLine label="Costs marked for tax" value={t.totalExpenses} />
        <p style={{ ...S.text, fontSize: 11, margin: '12px 0 0' }}>After refunds · updated through {date(t.asAt)}</p>
      </div>
    </section>
    {needsChecking > 0 && <TaxDetails title="Cash & bank receipts">
      <p style={S.text}>{needsChecking} appointments have no confirmed receipt. Record any cash or bank payments you received to include them here.</p>
      {t.assumedCount > 0 && <MoneyLine label="Payment not confirmed" value={t.assumedIncome} />}
      <Button variant="secondary" size="sm" onClick={onReview} style={{ margin: '8px 0 14px' }}>Review payments</Button>
    </TaxDetails>}
    <Button fullWidth disabled={hidden || exporting} onClick={() => onExport(t.taxYear)} style={{ margin: '0 0 20px' }}>{exporting ? 'Preparing export…' : 'Export for Accountant'}</Button>
    <TaxDetails title="Tax estimate">
      {t.illustration ? <>
        {needsChecking > 0 && <p style={S.text}>Check the payments above before relying on this estimate.</p>}
        <MoneyLine label="Income Tax" value={t.illustration.incomeTax} />
        <MoneyLine label="Class 4 National Insurance" value={t.illustration.niClass4} />
        <MoneyLine label="Illustration total" value={t.illustration.total} strong />
        <p style={S.text}>Based only on these records. This is not your final tax bill or a savings target.</p>
        <TaxDetails title="How the estimate works" nested><p style={S.text}>For a sole trader in England, Wales or Northern Ireland, with no other income or reliefs. It includes the personal allowance taper. Scottish rates differ. Class 2 is not compulsory; voluntary contributions may apply.</p><p style={S.text}>Payments on account depend on your previous tax bill and tax already paid. Check your HMRC account for amounts and dates.</p><p style={S.text}><a href="https://www.gov.uk/income-tax-rates" target="_blank" rel="noreferrer">Income Tax rates</a> · <a href="https://www.gov.uk/self-employed-national-insurance-rates" target="_blank" rel="noreferrer">National Insurance rates</a> · <a href="https://www.gov.uk/understand-self-assessment-bill/payments-on-account" target="_blank" rel="noreferrer">Payments on account</a></p></TaxDetails>
      </> : <p style={S.text}>An estimate is not available for this tax year or business/VAT setup. Share your records with your accountant.</p>}
    </TaxDetails>
    <TaxDetails title="VAT &amp; business setup">
      <p style={S.text}>{t.businessType === 'sole_trader' ? 'Sole trader' : 'Limited company'} · {t.vat.registered ? 'VAT registered' : 'Not VAT registered'}</p>
      {t.vat.registered ? <p style={S.text}>Florrie does not yet calculate VAT returns. Your accountant needs the VAT on each sale and cost, your scheme and return dates.</p> : <><MoneyLine label="Payments recorded · last 12 months" value={t.vat.rolling12Revenue} /><p style={S.text}>The £90,000 VAT threshold is based on taxable sales, including unpaid sales and sales outside Florrie. Also check expected sales over the next 30 days.</p></>}
      <p style={S.text}><a href="https://www.gov.uk/register-for-vat" target="_blank" rel="noreferrer">Check HMRC’s VAT rules</a></p><Button variant="secondary" size="sm" onClick={onSettings} style={{ marginBottom: 14 }}>Update VAT settings</Button>
    </TaxDetails>
    <TaxDetails title="Costs by category">{Object.entries(t.expensesByCategory).sort(([,a],[,b]) => b.total_cents-a.total_cents).map(([key,data]) => <MoneyLine key={key} label={`${key.charAt(0).toUpperCase()+key.slice(1)} (${data.count})`} value={data.total_cents} />)}{!t.expenseCount && <p style={S.text}>No costs marked for tax in this year.</p>}</TaxDetails>
    <TaxDetails title="Money received by month">{Object.entries(t.monthlyIncome).sort(([a],[b]) => a.localeCompare(b)).map(([month,cents]) => <MoneyLine key={month} label={new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} value={cents} />)}{!Object.keys(t.monthlyIncome).length && <p style={S.text}>No payments recorded in this year.</p>}</TaxDetails>
    <TaxDetails title="What’s included?"><p style={S.text}>{t.transactionCount} counted transactions and {t.expenseCount} costs marked deductible. Deposits count when paid; refunds reduce income. Repeated card-payment references count once.</p><p style={S.text}>Add missing payments, costs and fees before using these records for your tax return. Your accountant can confirm which costs qualify.</p>{t.duplicateCount > 0 && <p style={S.text}>{t.duplicateCount} duplicate records are excluded.</p>}</TaxDetails>
  </section>;
}
