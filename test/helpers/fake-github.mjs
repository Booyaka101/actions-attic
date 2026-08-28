/**
 * An in-process stand-in for the GitHub REST endpoints actions-attic reads.
 * Test-only: it exists so the budget, split and resume paths can be driven
 * deterministically. The shipped product never talks to it.
 */

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** GitHub will not serve more than this many results for one filtered search. */
const SEARCH_CAP = 1000;

export function makeFakeGitHub(opts = {}) {
  const runs = [...(opts.runs ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const checks = opts.checks ?? {};
  const statuses = opts.statuses ?? {};
  const state = { requests: 0, paths: [], rateRemaining: opts.rateStart ?? 5000 };

  async function fetchImpl(rawUrl) {
    state.requests++;
    state.rateRemaining = Math.max(0, state.rateRemaining - 1);
    const url = new URL(rawUrl);
    state.paths.push(url.pathname + url.search);

    const headers = {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(state.rateRemaining),
      'x-ratelimit-reset': String(Math.floor(Date.UTC(2026, 7, 28, 12) / 1000)),
    };

    if (opts.secondaryLimitAfter && state.requests > opts.secondaryLimitAfter) {
      return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
        status: 403,
        headers: { ...headers, 'retry-after': String(opts.retryAfter ?? 3600) },
      });
    }

    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');

    if (url.pathname.endsWith('/actions/runs')) {
      const created = url.searchParams.get('created');
      let matched = runs;
      if (created) {
        const [start, end] = created.split('..');
        matched = runs.filter((r) => {
          const day = r.created_at.slice(0, 10);
          return day >= start && day <= end;
        });
      }
      const capped = matched.slice(0, SEARCH_CAP);
      const slice = capped.slice((page - 1) * perPage, page * perPage);
      return json({ total_count: matched.length, workflow_runs: slice }, headers);
    }

    const check = /\/commits\/([^/]+)\/check-runs$/.exec(url.pathname);
    if (check) {
      const list = checks[check[1]] ?? [];
      return json({ total_count: list.length, check_runs: list.slice((page - 1) * perPage, page * perPage) }, headers);
    }

    const status = /\/commits\/([^/]+)\/statuses$/.exec(url.pathname);
    if (status) {
      if (opts.statusesForbidden) {
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403,
          headers,
        });
      }
      const list = statuses[status[1]] ?? [];
      return json(list.slice((page - 1) * perPage, page * perPage), headers);
    }

    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
  }

  return { fetchImpl, state };
}

/** Deterministic run payloads shaped like the real workflow-run response. */
export function makeRuns({ month, count, startId = 1_000_000, days = 28, name = 'ci' }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const day = String((i % days) + 1).padStart(2, '0');
    const minute = String(i % 60).padStart(2, '0');
    out.push({
      id,
      name,
      status: 'completed',
      conclusion: i % 7 === 0 ? 'failure' : 'success',
      created_at: `${month}-${day}T10:${minute}:00Z`,
      updated_at: `${month}-${day}T10:${minute}:30Z`,
      run_started_at: `${month}-${day}T10:${minute}:05Z`,
      head_sha: String(id).padStart(40, 'b'),
      head_branch: 'main',
      event: 'push',
      actor: { login: 'octocat' },
      triggering_actor: { login: 'octocat' },
      run_number: i + 1,
      run_attempt: 1,
      workflow_id: 42,
      html_url: `https://github.com/acme/widget/actions/runs/${id}`,
    });
  }
  return out;
}
