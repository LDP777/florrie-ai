// In-memory PostgREST contract for the staged journey: tenant filters, JSON CAS,
// immutable snapshots and unique response IDs behave like the production tables.
export function preparationDb(tables = {}) {
  const state = { tables, fail: null, beforeUpdate: null };
  const value = (r, k) => k.includes('->>') ? (r[k.split('->>')[0]]?.[k.split('->>')[1]] == null ? null : String(r[k.split('->>')[0]][k.split('->>')[1]])) : r[k];
  state.from = table => {
    const filters = []; let write; let one = false; let limit = Infinity; let sort;
    const joined = row => {
      if (table === 'appointments') return { ...row, beauticians: tables.beauticians?.find(b => b.id === row.beautician_id), clients: tables.clients?.find(c => c.id === row.client_id) };
      if (table === 'consultation_responses') return { ...row, consultation_forms: tables.consultation_forms?.find(f => f.id === row.form_id), clients: tables.clients?.find(c => c.id === row.client_id), beauticians: tables.beauticians?.find(b => b.id === row.beautician_id), appointments: tables.appointments?.find(a => a.id === row.appointment_id) };
      return row;
    };
    const settle = () => {
      if (state.fail === table) return { data: null, error: { message: 'Synthetic database failure' } };
      if (write?.type === 'update' && state.beforeUpdate) { const fn = state.beforeUpdate; state.beforeUpdate = null; fn(); }
      const all = tables[table] ||= [];
      let rows = all.filter(r => filters.every(f => f(r)));
      if (sort) rows.sort((a,b) => String(value(a, sort.k)).localeCompare(String(value(b, sort.k))) * (sort.ascending ? 1 : -1));
      rows = rows.slice(0, limit);
      if (write?.type === 'insert') {
        const row = { id: `row-${all.length}`, created_at: new Date().toISOString(), ...write.data };
        if (all.some(r => r.id === row.id)) return { data: null, error: { code: '23505' } };
        if (table === 'consultation_responses') row.form_snapshot = structuredClone(tables.consultation_forms?.find(f => f.id === row.form_id));
        all.push(row); rows = [row];
      }
      if (write?.type === 'update') rows.forEach(r => Object.assign(r, write.data));
      if (write?.type === 'delete') tables[table] = all.filter(r => !rows.includes(r));
      return { data: one ? rows[0] ? structuredClone(joined(rows[0])) : null : structuredClone(rows.map(joined)), error: null };
    };
    const q = {
      select: () => q, eq: (k,v) => { filters.push(r => value(r,k) === v); return q; }, neq: (k,v) => { filters.push(r => value(r,k) !== v); return q; },
      in: (k,v) => { filters.push(r => v.includes(value(r,k))); return q; }, is: (k,v) => { filters.push(r => (value(r,k) ?? null) === v); return q; },
      order: (k,opts={}) => { sort={k,ascending:opts.ascending !== false}; return q; }, limit: n => { limit=n; return q; },
      insert: data => {write={type:'insert',data};return q;}, update: data => {write={type:'update',data};return q;}, delete: () => {write={type:'delete'};return q;},
      single: () => {one=true;return Promise.resolve(settle());}, maybeSingle: () => {one=true;return Promise.resolve(settle());}, then: (a,b) => Promise.resolve(settle()).then(a,b),
    }; return q;
  };
  return state;
}
