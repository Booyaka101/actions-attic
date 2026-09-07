/** Month-bucket arithmetic for the backfill windows. Everything is UTC. */

export type Month = string; // YYYY-MM

export interface Window {
  start: string; // YYYY-MM-DD, or an ISO instant once split below a day, inclusive
  end: string; // YYYY-MM-DD, or an ISO instant once split below a day, inclusive
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

export function assertMonth(value: string, what = 'month'): Month {
  if (!isMonth(value)) throw new Error(`${what} must look like YYYY-MM, got "${value}"`);
  return value;
}

export function assertDate(value: string, what = 'date'): string {
  if (!DATE_RE.test(value)) throw new Error(`${what} must look like YYYY-MM-DD, got "${value}"`);
  return value;
}

/** Month a timestamp belongs to. Accepts any ISO-8601 instant. */
export function monthOf(iso: string): Month {
  return iso.slice(0, 7);
}

function parseMonth(m: Month): { year: number; month: number } {
  assertMonth(m);
  return { year: Number(m.slice(0, 4)), month: Number(m.slice(5, 7)) };
}

export function monthToIndex(m: Month): number {
  const { year, month } = parseMonth(m);
  return year * 12 + (month - 1);
}

export function indexToMonth(index: number): Month {
  const year = Math.floor(index / 12);
  const mon = index - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(mon).padStart(2, '0')}`;
}

/** Shift by whole months; handles year rollover in both directions. */
export function shiftMonth(m: Month, delta: number): Month {
  return indexToMonth(monthToIndex(m) + delta);
}

export function daysInMonth(m: Month): number {
  const { year, month } = parseMonth(m);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthWindow(m: Month): Window {
  return { start: `${m}-01`, end: `${m}-${String(daysInMonth(m)).padStart(2, '0')}` };
}

/** First day of the month, the form stored in `manifest.backfillFrontier`. */
export function monthStart(m: Month): string {
  return `${assertMonth(m)}-01`;
}

export function monthOfFrontier(frontier: string): Month {
  return assertDate(frontier, 'frontier').slice(0, 7);
}

/** `count` months ending at `from`, newest first. */
export function monthsBack(from: Month, count: number): Month[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`month count must be a positive integer, got ${count}`);
  const end = monthToIndex(from);
  const out: Month[] = [];
  for (let i = 0; i < count; i++) out.push(indexToMonth(end - i));
  return out;
}

function toUtc(date: string): number {
  assertDate(date);
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / DAY) + 1;
}

const SECOND = 1000;

/** A window bound is either a whole day (`YYYY-MM-DD`) or an instant, once split below a day. */
function isInstant(bound: string): boolean {
  return bound.length > 10;
}

function startMs(bound: string): number {
  return isInstant(bound) ? Date.parse(bound) : toUtc(bound);
}

/** A date bound covers the whole day, so its end is the last second of it. */
function endMs(bound: string): number {
  return isInstant(bound) ? Date.parse(bound) : toUtc(bound) + DAY - SECOND;
}

function toInstant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * Halve a window. Above a day it halves on the date, below one it halves on the
 * second: `created` honours full instants, and a repository doing more than
 * 1,000 runs a day is otherwise capped at 1,000 for that whole day. Returns null
 * only for a one-second window, where the cap really is irreducible.
 */
export function splitWindow(w: Window): [Window, Window] | null {
  if (!isInstant(w.start) && !isInstant(w.end)) {
    const span = daysBetween(w.start, w.end);
    if (span >= 2) {
      const firstEnd = addDays(w.start, Math.floor(span / 2) - 1);
      return [
        { start: w.start, end: firstEnd },
        { start: addDays(firstEnd, 1), end: w.end },
      ];
    }
  }
  const start = startMs(w.start);
  const end = endMs(w.end);
  if (end - start < SECOND) return null;
  const mid = start + Math.floor((end - start) / 2 / SECOND) * SECOND;
  return [
    { start: toInstant(start), end: toInstant(mid) },
    { start: toInstant(mid + SECOND), end: toInstant(end) },
  ];
}

export function formatWindow(w: Window): string {
  return `${w.start}..${w.end}`;
}

/** UTC month for a Date, so the Action and the CLI bucket identically. */
export function currentMonth(now: Date = new Date()): Month {
  return now.toISOString().slice(0, 7);
}
