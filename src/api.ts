/**
 * Minimal paginating GitHub REST client.
 *
 * Two budgets have to be respected at once: the caller's `maxRequests` ceiling
 * (GITHUB_TOKEN gets 1,000 requests/hour/repository) and the live
 * x-ratelimit-remaining header. `budgetExhausted()` reports either, so callers
 * can checkpoint and exit 0 instead of dying mid-backfill.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string, message?: string) {
    super(message ?? `GitHub API ${status} for ${url}${body ? `: ${truncate(body, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class BudgetExhausted extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`request budget exhausted: ${reason}`);
    this.name = 'BudgetExhausted';
    this.reason = reason;
  }
}

export class NetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`could not reach ${url} (${describe(cause)}). Check your network or proxy settings.`);
    this.name = 'NetworkError';
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : null;
    return code ? `${err.message}; ${code}` : err.message;
  }
  return String(err);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export interface ApiOptions {
  token: string;
  maxRequests: number;
  baseUrl?: string;
  /** Stop this far short of the live rate limit so the caller can still commit. */
  reserve?: number;
  /** Longest `retry-after` we will wait out before checkpointing instead. */
  maxRetryAfterSeconds?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface ListOptions<T> {
  perPage?: number;
  maxPages?: number;
  /** Resume point, so a window interrupted by the budget need not restart. */
  startPage?: number;
  /** Called after each page lands, for page-level checkpointing. */
  onPage?: (page: number, items: T[]) => void;
  /** Envelope key holding the array (`workflow_runs`, `check_runs`); null for bare arrays. */
  key?: string | null;
  /** Return false to stop before paginating, e.g. when total_count hits the 1,000 cap. */
  onFirstPage?: (totalCount: number) => boolean;
  /** Return true to stop after the page just consumed. */
  stop?: (page: T[], all: T[]) => boolean | Promise<boolean>;
  /** Accumulator that survives a thrown BudgetExhausted, so partial work is kept. */
  sink?: T[];
}

export interface ListResult<T> {
  items: T[];
  totalCount: number;
  /** False when pagination stopped early for budget, page cap or an explicit stop. */
  complete: boolean;
  /** True when `onFirstPage` refused the result set (the 1,000-result cap). */
  aborted: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Api {
  readonly baseUrl: string;
  readonly maxRequests: number;
  requests = 0;
  rateRemaining: number | null = null;
  rateLimit: number | null = null;
  rateReset: number | null = null;

  private readonly token: string;
  private readonly reserve: number;
  private readonly maxRetryAfter: number;
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private exhaustedReason: string | null = null;

  constructor(opts: ApiOptions) {
    if (!opts.token) throw new Error('a GitHub token is required');
    if (!Number.isInteger(opts.maxRequests) || opts.maxRequests < 1) {
      throw new Error(`max-requests must be a positive integer, got ${opts.maxRequests}`);
    }
    this.token = opts.token;
    this.maxRequests = opts.maxRequests;
    this.baseUrl = (opts.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
    this.reserve = opts.reserve ?? 25;
    this.maxRetryAfter = opts.maxRetryAfterSeconds ?? 60;
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ?? (() => {});
    this.sleep = opts.sleep ?? defaultSleep;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  budgetExhausted(): boolean {
    return this.exhaustReason() !== null;
  }

  exhaustReason(): string | null {
    if (this.exhaustedReason) return this.exhaustedReason;
    if (this.requests >= this.maxRequests) return `reached the max-requests ceiling of ${this.maxRequests}`;
    if (this.rateRemaining !== null && this.rateRemaining <= this.reserve) {
      const at = this.rateReset ? new Date(this.rateReset * 1000).toISOString() : 'unknown';
      return `only ${this.rateRemaining} API requests left before the limit resets at ${at}`;
    }
    return null;
  }

  /** Force the exhausted state, e.g. after a secondary rate limit. */
  markExhausted(reason: string): void {
    this.exhaustedReason ??= reason;
  }

  private url(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private readRate(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const limit = headers.get('x-ratelimit-limit');
    if (remaining !== null && remaining !== '') this.rateRemaining = Number(remaining);
    if (reset !== null && reset !== '') this.rateReset = Number(reset);
    if (limit !== null && limit !== '') this.rateLimit = Number(limit);
  }

  async request<T>(
    path: string,
    opts: { params?: Record<string, string | number | undefined>; method?: string; body?: unknown } = {},
  ): Promise<{ status: number; headers: Headers; data: T }> {
    const reason = this.exhaustReason();
    if (reason) throw new BudgetExhausted(reason);

    const url = this.url(path, opts.params);
    const method = opts.method ?? 'GET';
    let attempt = 0;

    for (;;) {
      attempt++;
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'actions-attic',
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (err) {
        if (attempt < 3 && !this.budgetExhausted()) {
          await this.sleep(500 * attempt);
          continue;
        }
        throw new NetworkError(url, err);
      }

      this.readRate(res.headers);

      if (res.status === 204 || res.status === 205) {
        return { status: res.status, headers: res.headers, data: undefined as T };
      }

      const text = await res.text();

      if (res.ok) {
        return { status: res.status, headers: res.headers, data: (text ? JSON.parse(text) : undefined) as T };
      }

      if (res.status === 403 || res.status === 429) {
        const limited = this.classifyLimit(res.headers, text);
        if (limited === 'primary') {
          const at = this.rateReset ? new Date(this.rateReset * 1000).toISOString() : 'unknown';
          this.markExhausted(`primary rate limit reached, resets at ${at}`);
          throw new BudgetExhausted(this.exhaustedReason!);
        }
        if (limited === 'secondary') {
          const retryAfter = Number(res.headers.get('retry-after') ?? '0');
          if (attempt < 3 && retryAfter > 0 && retryAfter <= this.maxRetryAfter) {
            this.warn(`secondary rate limit; honouring retry-after ${retryAfter}s`);
            await this.sleep(retryAfter * 1000);
            continue;
          }
          this.markExhausted(
            retryAfter > 0
              ? `secondary rate limit, retry-after ${retryAfter}s is longer than this run will wait`
              : 'secondary rate limit with no retry-after',
          );
          throw new BudgetExhausted(this.exhaustedReason!);
        }
      }

      if (res.status >= 500 && attempt < 4 && !this.budgetExhausted()) {
        this.log(`GitHub returned ${res.status}; retrying (${attempt}/3)`);
        await this.sleep(1000 * attempt);
        continue;
      }

      throw new HttpError(res.status, url, text);
    }
  }

  private classifyLimit(headers: Headers, body: string): 'primary' | 'secondary' | null {
    if (headers.get('x-ratelimit-remaining') === '0') return 'primary';
    if (/secondary rate limit/i.test(body)) return 'secondary';
    if (headers.get('retry-after')) return 'secondary';
    return null;
  }

  /** Paginate a list endpoint. Partial pages already fetched stay in `opts.sink`. */
  async list<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    opts: ListOptions<T> = {},
  ): Promise<ListResult<T>> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const startPage = opts.startPage ?? 1;
    const lastPage = startPage + maxPages - 1;
    const key = opts.key === undefined ? null : opts.key;
    const all: T[] = opts.sink ?? [];
    const before = all.length;
    let totalCount = 0;
    let complete = true;

    for (let page = startPage; page <= lastPage; page++) {
      const { data } = await this.request<unknown>(path, { params: { ...params, per_page: perPage, page } });
      const { items, total } = unwrap<T>(data, key);
      if (page === startPage) totalCount = total ?? items.length;
      if (page === 1 && opts.onFirstPage && !opts.onFirstPage(totalCount)) {
        all.push(...items);
        opts.onPage?.(page, items);
        return { items: all.slice(before), totalCount, complete: false, aborted: true };
      }
      all.push(...items);
      opts.onPage?.(page, items);

      if (items.length < perPage) return { items: all.slice(before), totalCount, complete: true, aborted: false };
      if (opts.stop && (await opts.stop(items, all)))
        return { items: all.slice(before), totalCount, complete: false, aborted: false };
      if (page === lastPage) complete = false;
    }

    return { items: all.slice(before), totalCount, complete, aborted: false };
  }
}

function unwrap<T>(data: unknown, key: string | null): { items: T[]; total: number | null } {
  if (Array.isArray(data)) return { items: data as T[], total: null };
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const arr = key ? obj[key] : undefined;
    if (Array.isArray(arr)) {
      const total = typeof obj.total_count === 'number' ? obj.total_count : null;
      return { items: arr as T[], total };
    }
  }
  return { items: [], total: null };
}
