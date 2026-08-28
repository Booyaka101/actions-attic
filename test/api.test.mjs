import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, BudgetExhausted, HttpError, NetworkError } from '../lib/api.js';

const quiet = () => {};
const nap = async () => {};

function respond(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('the max-requests ceiling stops before the next call', async () => {
  let calls = 0;
  const api = new Api({
    token: 't',
    maxRequests: 2,
    sleep: nap,
    fetchImpl: async () => {
      calls++;
      return respond(200, { total_count: 0, workflow_runs: [] }, { 'x-ratelimit-remaining': '4000' });
    },
  });
  await api.request('/one');
  await api.request('/two');
  assert.equal(api.budgetExhausted(), true);
  await assert.rejects(api.request('/three'), BudgetExhausted);
  assert.equal(calls, 2);
  assert.match(api.exhaustReason(), /max-requests ceiling of 2/);
});

test('x-ratelimit-remaining is read off every response and reserves headroom', async () => {
  const api = new Api({
    token: 't',
    maxRequests: 100,
    reserve: 25,
    sleep: nap,
    fetchImpl: async () => respond(200, {}, { 'x-ratelimit-remaining': '24', 'x-ratelimit-reset': '1790000000' }),
  });
  await api.request('/x');
  assert.equal(api.rateRemaining, 24);
  assert.equal(api.rateReset, 1790000000);
  assert.equal(api.budgetExhausted(), true);
  assert.match(api.exhaustReason(), /only 24 API requests left/);
});

test('a primary rate limit becomes a checkpoint, not a crash', async () => {
  const api = new Api({
    token: 't',
    maxRequests: 100,
    sleep: nap,
    fetchImpl: async () =>
      respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
  });
  await assert.rejects(api.request('/x'), BudgetExhausted);
  assert.match(api.exhaustReason(), /primary rate limit/);
});

test('a short retry-after is honoured, a long one checkpoints', async () => {
  const slept = [];
  let calls = 0;
  const short = new Api({
    token: 't',
    maxRequests: 100,
    sleep: async (ms) => void slept.push(ms),
    warn: quiet,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? respond(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '2' })
        : respond(200, { ok: true });
    },
  });
  const res = await short.request('/x');
  assert.deepEqual(res.data, { ok: true });
  assert.deepEqual(slept, [2000]);

  const long = new Api({
    token: 't',
    maxRequests: 100,
    sleep: nap,
    warn: quiet,
    fetchImpl: async () => respond(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '3600' }),
  });
  await assert.rejects(long.request('/x'), BudgetExhausted);
  assert.match(long.exhaustReason(), /secondary rate limit/);
});

test('5xx is retried, then surfaces as a readable HttpError', async () => {
  let calls = 0;
  const api = new Api({
    token: 't',
    maxRequests: 100,
    sleep: nap,
    log: quiet,
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? respond(502, 'bad gateway') : respond(200, { ok: true });
    },
  });
  assert.deepEqual((await api.request('/x')).data, { ok: true });
  assert.equal(calls, 3);

  const dead = new Api({ token: 't', maxRequests: 100, sleep: nap, log: quiet, fetchImpl: async () => respond(500, 'boom') });
  await assert.rejects(dead.request('/x'), (err) => err instanceof HttpError && err.status === 500);
});

test('a network failure is retried then reported without a stack trace', async () => {
  const api = new Api({
    token: 't',
    maxRequests: 100,
    sleep: nap,
    fetchImpl: async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    },
  });
  await assert.rejects(api.request('/x'), (err) => {
    assert.ok(err instanceof NetworkError);
    assert.match(err.message, /could not reach .*ENOTFOUND/);
    return true;
  });
});

test('list() unwraps envelopes, bare arrays and total_count', async () => {
  const pages = [
    { total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] },
    { total_count: 3, workflow_runs: [{ id: 3 }] },
  ];
  let page = 0;
  const api = new Api({ token: 't', maxRequests: 100, sleep: nap, fetchImpl: async () => respond(200, pages[page++]) });
  const res = await api.list('/runs', {}, { key: 'workflow_runs', perPage: 2 });
  assert.deepEqual(res.items.map((r) => r.id), [1, 2, 3]);
  assert.equal(res.totalCount, 3);
  assert.equal(res.complete, true);

  const bare = new Api({ token: 't', maxRequests: 100, sleep: nap, fetchImpl: async () => respond(200, [{ id: 9 }]) });
  const res2 = await bare.list('/statuses', {}, { key: null });
  assert.deepEqual(res2.items, [{ id: 9 }]);
  assert.equal(res2.totalCount, 1);
});

test('onFirstPage can abort a search that would hit the result cap', async () => {
  const api = new Api({
    token: 't',
    maxRequests: 100,
    sleep: nap,
    fetchImpl: async () => respond(200, { total_count: 1000, workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i })) }),
  });
  const res = await api.list('/runs', {}, { key: 'workflow_runs', onFirstPage: (total) => total < 1000 });
  assert.equal(res.aborted, true);
  assert.equal(api.requests, 1);
});

test('constructing an Api with bad arguments fails immediately', () => {
  assert.throws(() => new Api({ token: '', maxRequests: 10 }), /token is required/);
  assert.throws(() => new Api({ token: 't', maxRequests: 0 }), /positive integer/);
});
