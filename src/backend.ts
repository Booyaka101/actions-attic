/**
 * Where the archive lives. Two backends, one interface: a plain directory (CLI)
 * and an orphan branch driven through the Git Data API (the Action, which never
 * needs to check that branch out).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { Api, HttpError } from './api.js';

export interface CommitResult {
  changed: string[];
  sha: string | null;
}

export interface Backend {
  /** Paths already stored, POSIX-separated and repo-root relative. */
  paths(): string[];
  read(path: string): Promise<string | null>;
  write(path: string, content: string): void;
  /** Persist staged writes. Returns null when nothing actually changed. */
  commit(message: string): Promise<CommitResult | null>;
  describe(): string;
}

/** git's own object id, so we can skip uploading blobs that are byte-identical. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

export class FsBackend implements Backend {
  private known = new Set<string>();
  private staged = new Map<string, string>();
  private cache = new Map<string, string>();

  constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<FsBackend> {
    const backend = new FsBackend(dir);
    for (const path of await walk(dir)) backend.known.add(path);
    return backend;
  }

  paths(): string[] {
    return [...new Set([...this.known, ...this.staged.keys()])].sort();
  }

  async read(path: string): Promise<string | null> {
    const staged = this.staged.get(path);
    if (staged !== undefined) return staged;
    if (this.cache.has(path)) return this.cache.get(path)!;
    if (!this.known.has(path)) return null;
    const content = await readFile(join(this.dir, ...path.split('/')), 'utf8');
    this.cache.set(path, content);
    return content;
  }

  write(path: string, content: string): void {
    this.staged.set(path, content);
  }

  async commit(_message: string): Promise<CommitResult | null> {
    const changed: string[] = [];
    for (const [path, content] of this.staged) {
      const current = this.known.has(path) ? await readFile(join(this.dir, ...path.split('/')), 'utf8') : null;
      if (current === content) continue;
      const full = join(this.dir, ...path.split('/'));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
      this.known.add(path);
      this.cache.set(path, content);
      changed.push(path);
    }
    this.staged.clear();
    return changed.length ? { changed: changed.sort(), sha: null } : null;
  }

  describe(): string {
    return this.dir;
  }
}

interface TreeEntry {
  path: string;
  sha: string;
  type: string;
}

/**
 * An orphan branch written with blobs -> tree -> commit -> ref. Files that hash
 * to the sha already in the tree are never uploaded, so an unchanged night
 * costs zero writes and produces no commit.
 */
export class BranchBackend implements Backend {
  private tree = new Map<string, string>();
  private staged = new Map<string, string>();
  private cache = new Map<string, string>();
  private headSha: string | null = null;
  private treeSha: string | null = null;
  private loaded = false;

  constructor(
    private readonly api: Api,
    private readonly owner: string,
    private readonly repo: string,
    private readonly branch: string,
    private readonly opts: {
      committer?: { name: string; email: string };
      warn?: (msg: string) => void;
    } = {},
  ) {}

  static async open(
    api: Api,
    owner: string,
    repo: string,
    branch: string,
    opts?: { committer?: { name: string; email: string }; warn?: (msg: string) => void },
  ): Promise<BranchBackend> {
    const backend = new BranchBackend(api, owner, repo, branch, opts);
    await backend.load();
    return backend;
  }

  private get base(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  private async load(): Promise<void> {
    this.tree.clear();
    this.cache.clear();
    this.headSha = null;
    this.treeSha = null;
    try {
      const ref = await this.api.request<{ object: { sha: string } }>(
        `${this.base}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      );
      this.headSha = ref.data.object.sha;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        this.loaded = true;
        return; // branch does not exist yet; first commit creates it as an orphan
      }
      throw err;
    }
    const commit = await this.api.request<{ tree: { sha: string } }>(`${this.base}/git/commits/${this.headSha}`);
    this.treeSha = commit.data.tree.sha;
    const tree = await this.api.request<{ tree: TreeEntry[]; truncated: boolean }>(
      `${this.base}/git/trees/${this.treeSha}`,
      { params: { recursive: '1' } },
    );
    if (tree.data.truncated) {
      this.opts.warn?.('archive branch tree came back truncated; some months may be re-fetched');
    }
    for (const entry of tree.data.tree) {
      if (entry.type === 'blob') this.tree.set(entry.path, entry.sha);
    }
    this.loaded = true;
  }

  /** True when the branch does not exist yet. */
  get isNew(): boolean {
    return this.loaded && this.headSha === null;
  }

  paths(): string[] {
    return [...new Set([...this.tree.keys(), ...this.staged.keys()])].sort();
  }

  async read(path: string): Promise<string | null> {
    const staged = this.staged.get(path);
    if (staged !== undefined) return staged;
    if (this.cache.has(path)) return this.cache.get(path)!;
    const sha = this.tree.get(path);
    if (!sha) return null;
    const blob = await this.api.request<{ content: string; encoding: string }>(`${this.base}/git/blobs/${sha}`);
    const content =
      blob.data.encoding === 'base64'
        ? Buffer.from(blob.data.content, 'base64').toString('utf8')
        : blob.data.content;
    this.cache.set(path, content);
    return content;
  }

  write(path: string, content: string): void {
    this.staged.set(path, content);
  }

  async commit(message: string): Promise<CommitResult | null> {
    return this.commitOnce(message, true);
  }

  private async commitOnce(message: string, mayRetry: boolean): Promise<CommitResult | null> {
    const pending = [...this.staged].filter(([path, content]) => this.tree.get(path) !== gitBlobSha(content));
    if (pending.length === 0) {
      this.staged.clear();
      return null;
    }

    const blobs: { path: string; sha: string }[] = [];
    for (const [path, content] of pending) {
      const res = await this.api.request<{ sha: string }>(`${this.base}/git/blobs`, {
        method: 'POST',
        body: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
      });
      blobs.push({ path, sha: res.data.sha });
    }

    const treeRes = await this.api.request<{ sha: string }>(`${this.base}/git/trees`, {
      method: 'POST',
      body: {
        ...(this.treeSha ? { base_tree: this.treeSha } : {}),
        tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
      },
    });

    if (treeRes.data.sha === this.treeSha) {
      this.staged.clear();
      return null;
    }

    const commitRes = await this.api.request<{ sha: string }>(`${this.base}/git/commits`, {
      method: 'POST',
      body: {
        message,
        tree: treeRes.data.sha,
        parents: this.headSha ? [this.headSha] : [],
        ...(this.opts.committer ? { author: this.opts.committer, committer: this.opts.committer } : {}),
      },
    });

    const newHead = commitRes.data.sha;
    try {
      if (this.headSha) {
        await this.api.request(`${this.base}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
          method: 'PATCH',
          body: { sha: newHead },
        });
      } else {
        await this.api.request(`${this.base}/git/refs`, {
          method: 'POST',
          body: { ref: `refs/heads/${this.branch}`, sha: newHead },
        });
      }
    } catch (err) {
      const raced = err instanceof HttpError && (err.status === 409 || err.status === 422);
      if (raced && mayRetry) {
        this.opts.warn?.(`branch ${this.branch} moved under us (${(err as HttpError).status}); reloading and retrying once`);
        const staged = new Map(this.staged);
        await this.load();
        this.staged = staged;
        return this.commitOnce(message, false);
      }
      if (raced) {
        throw new Error(
          `could not update refs/heads/${this.branch} after one retry: ${(err as HttpError).message}. ` +
            'Another job is probably writing the archive branch at the same time; re-run once it finishes.',
        );
      }
      throw err;
    }

    for (const b of blobs) this.tree.set(b.path, b.sha);
    for (const [path, content] of this.staged) this.cache.set(path, content);
    this.staged.clear();
    this.headSha = newHead;
    this.treeSha = treeRes.data.sha;
    return { changed: blobs.map((b) => b.path).sort(), sha: newHead };
  }

  describe(): string {
    return `${this.owner}/${this.repo}@${this.branch}`;
  }
}

export const joinPath = posix.join;
