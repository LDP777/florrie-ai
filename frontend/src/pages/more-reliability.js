// Appointment timestamps store salon wall time. Compare their date component.
export function rebookClients(rows, today) {
  const day = value => Date.parse(String(value || '').slice(0, 10) + 'T12:00:00Z');
  const now = day(today);
  return rows.map(c => {
    const visits = (c.appointments || []).filter(a => a.status === 'completed' && Number.isFinite(day(a.starts_at)) && day(a.starts_at) <= now)
      .sort((a, b) => day(b.starts_at) - day(a.starts_at));
    if (!visits.length || c.archived_at || c.marketing_opted_out_at) return null;
    const dates = [...new Set(visits.map(a => day(a.starts_at)))];
    const avgInterval = dates.length > 1 ? Math.max(1, Math.round((dates[0] - dates.at(-1)) / 86400000 / (dates.length - 1))) : 28;
    const elapsed = Math.floor((now - dates[0]) / 86400000);
    if (elapsed < avgInterval - 7) return null;
    return { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Client',
      lastVisit: visits[0].starts_at.slice(0, 10), treatment: visits[0].treatments?.name || visits[0].treatment_name || 'treatment',
      avgInterval, phone: !!c.phone, email: !!c.email,
      status: elapsed >= 60 ? 'dormant' : elapsed > avgInterval ? 'overdue' : 'due' };
  }).filter(Boolean);
}

export function voucherIsActive(voucher, now = Date.now()) {
  return voucher.status === 'active' && (!voucher.expires_at || Date.parse(voucher.expires_at) > now);
}

export async function successfulBatchIds(items, execute) {
  const succeeded = [];
  for (const item of items) {
    try {
      const response = await execute(item);
      const body = await response.json().catch(() => ({}));
      if (response.ok && !body.error && body.success !== false) succeeded.push(item.id);
    } catch { /* Keep failed items available to retry. */ }
  }
  return succeeded;
}
