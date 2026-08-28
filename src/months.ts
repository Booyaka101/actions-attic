/** Month-bucket arithmetic for the backfill windows. All dates are UTC `YYYY-MM-DD`. */

export type Month = string; // YYYY-MM

export interface Window {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
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

/**
 * Halve a window. Returns null when it is already a single day, which is the
 * point where the API's 1,000-result cap can no longer be worked around.
 */
export function splitWindow(w: Window): [Window, Window] | null {
  const span = daysBetween(w.start, w.end);
  if (span < 2) return null;
  const firstEnd = addDays(w.start, Math.floor(span / 2) - 1);
  return [
    { start: w.start, end: firstEnd },
    { start: addDays(firstEnd, 1), end: w.end },
  ];
}

export function formatWindow(w: Window): string {
  return `${w.start}..${w.end}`;
}

/** UTC month for a Date, so the Action and the CLI bucket identically. */
export function currentMonth(now: Date = new Date()): Month {
  return now.toISOString().slice(0, 7);
}
