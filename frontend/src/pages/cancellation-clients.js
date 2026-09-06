// A shared name is not evidence of a repeat cancellation by the same client.
export function cancellationClients(rows) {
  const clients = new Map();
  for (const row of rows) {
    if (!row.clientId || row.type === 'unpaid') continue;
    const entry = clients.get(row.clientId) || { name: row.client, total: 0, noShows: 0 };
    entry.total++;
    if (row.type === 'no-show') entry.noShows++;
    clients.set(row.clientId, entry);
  }
  return [...clients.entries()];
}
