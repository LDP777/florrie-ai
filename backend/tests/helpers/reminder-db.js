// Real PostgreSQL claims/constraints via PGlite; only the PostgREST transport is replaced.
export function reminderDb(pg) {
  const answer = async fn => {
    try { return { data: JSON.parse(JSON.stringify(await fn())), error: null }; }
    catch (error) { return { data: null, error }; }
  };
  const name = value => `"${String(value).replaceAll('"', '""')}"`;
  return {
    rpc: (fn, args) => answer(async () => (await pg.query(
      `SELECT * FROM public.${name(fn)}(${Object.keys(args).map((_, i) => `$${i+1}`).join(',')})`, Object.values(args))).rows),
    from(table) {
      let op = 'select', values, single = false, max = 10000; const filters = [], sorts = [];
      const run = () => answer(async () => {
        const params = [], bind = v => { params.push(v); return `$${params.length}`; };
        let sql;
        if (op === 'insert' || op === 'upsert') {
          const cols = Object.keys(values);
          sql = `INSERT INTO ${name(table)} (${cols.map(name).join(',')}) VALUES (${cols.map(k => bind(values[k])).join(',')})`;
          if (op === 'upsert') sql += ` ON CONFLICT(id) DO UPDATE SET ${cols.filter(k => k !== 'id').map(k => `${name(k)}=excluded.${name(k)}`).join(',')}`;
        } else {
          sql = op === 'update' ? `UPDATE ${name(table)} SET ${Object.entries(values).map(([k,v]) => `${name(k)}=${bind(v)}`).join(',')}`
            : op === 'delete' ? `DELETE FROM ${name(table)}` : `SELECT * FROM ${name(table)}`;
          if (filters.length) sql += ' WHERE ' + filters.map(([col, cmp, value]) => cmp === 'IN'
            ? `${name(col)} IN (${value.map(bind).join(',')})` : `${name(col)} ${cmp} ${bind(value)}`).join(' AND ');
        }
        if (op === 'select') {
          if (sorts.length) sql += ` ORDER BY ${sorts.map(name).join(',')}`;
          sql += ` LIMIT ${max}`;
        } else sql += ' RETURNING *';
        let rows = (await pg.query(sql, params)).rows;
        if (op === 'select' && table === 'appointments') rows = await Promise.all(rows.map(async row => ({ ...row,
          clients: (await pg.query('SELECT * FROM clients WHERE id=$1', [row.client_id])).rows[0],
          beauticians: (await pg.query('SELECT * FROM beauticians WHERE id=$1', [row.beautician_id])).rows[0],
        })));
        return single ? rows[0] || null : rows;
      });
      const q = {
        select: () => q, insert: v => {op='insert'; values=v;return q;}, upsert: v => {op='upsert';values=v;return q;},
        update: v => {op='update';values=v;return q;}, delete: () => {op='delete';return q;},
        eq: (k,v) => {filters.push([k,'=',v]);return q;}, in: (k,v) => {filters.push([k,'IN',v]);return q;},
        lt: (k,v) => {filters.push([k,'<',v]);return q;}, order: k => {sorts.push(k);return q;}, limit: n => {max=n;return q;},
        single: () => {single=true;return run();}, maybeSingle: () => {single=true;return run();}, then: (a,b) => run().then(a,b),
      };
      return q;
    },
  };
}
