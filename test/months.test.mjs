import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  currentMonth,
  daysBetween,
  daysInMonth,
  monthOf,
  monthStart,
  monthWindow,
  monthsBack,
  shiftMonth,
  splitWindow,
} from '../lib/months.js';

test('shiftMonth rolls over the year in both directions', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.equal(shiftMonth('2026-03', -14), '2025-01');
  assert.equal(shiftMonth('2025-11', 14), '2027-01');
  assert.equal(shiftMonth('2026-06', 0), '2026-06');
});

test('monthsBack walks a 14-month window across the year boundary', () => {
  const months = monthsBack('2026-08', 14);
  assert.equal(months.length, 14);
  assert.equal(months[0], '2026-08');
  assert.equal(months[months.length - 1], '2025-07');
  assert.ok(months.includes('2026-01'));
  assert.ok(months.includes('2025-12'));
  // strictly descending, no gaps
  for (let i = 1; i < months.length; i++) assert.equal(months[i], shiftMonth(months[i - 1], -1));
});

test('month windows cover leap and short months exactly', () => {
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2026-04'), 30);
  assert.deepEqual(monthWindow('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthWindow('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  assert.equal(monthStart('2026-04'), '2026-04-01');
});

test('splitWindow halves a month and bottoms out on a single day', () => {
  assert.deepEqual(splitWindow(monthWindow('2026-03')), [
    { start: '2026-03-01', end: '2026-03-15' },
    { start: '2026-03-16', end: '2026-03-31' },
  ]);
  assert.deepEqual(splitWindow(monthWindow('2026-02')), [
    { start: '2026-02-01', end: '2026-02-14' },
    { start: '2026-02-15', end: '2026-02-28' },
  ]);
  assert.equal(splitWindow({ start: '2026-03-07', end: '2026-03-07' }), null);
  assert.deepEqual(splitWindow({ start: '2026-03-07', end: '2026-03-08' }), [
    { start: '2026-03-07', end: '2026-03-07' },
    { start: '2026-03-08', end: '2026-03-08' },
  ]);
});

test('repeated splitting stays contiguous and loses no day', () => {
  const seen = new Set();
  const walk = (w) => {
    const halves = splitWindow(w);
    if (!halves) {
      seen.add(w.start);
      return;
    }
    assert.equal(addDays(halves[0].end, 1), halves[1].start);
    for (const h of halves) walk(h);
  };
  walk(monthWindow('2026-01'));
  assert.equal(seen.size, 31);
});

test('date helpers agree across a year boundary', () => {
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 31);
  assert.equal(monthOf('2026-02-14T08:00:00Z'), '2026-02');
  assert.equal(currentMonth(new Date('2026-08-28T23:59:59Z')), '2026-08');
});

test('bad month strings are rejected with a readable message', () => {
  assert.throws(() => monthsBack('2026-13', 2), /YYYY-MM/);
  assert.throws(() => monthsBack('2026-08', 0), /positive integer/);
});
