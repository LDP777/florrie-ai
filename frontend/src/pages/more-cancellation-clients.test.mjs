import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellationClients } from './cancellation-clients.js';

test('repeat counts use client identity and exclude unpaid releases', () => {
  const rows = [
    { clientId: 'a', client: 'Alex Smith', type: 'no-show' },
    { clientId: 'b', client: 'Alex Smith', type: 'cancelled' },
    { clientId: 'a', client: 'Alex Smith', type: 'cancelled' },
    { clientId: 'a', client: 'Alex Smith', type: 'unpaid' },
    { client: 'Alex Smith', type: 'no-show' },
  ];
  const counts = new Map(cancellationClients(rows));
  assert.equal(counts.size, 2);
  assert.deepEqual(counts.get('a'), { name: 'Alex Smith', total: 2, noShows: 1 });
  assert.deepEqual(counts.get('b'), { name: 'Alex Smith', total: 1, noShows: 0 });
});
