/**
 * Schedule grammar parsing and next-run computation (spec D4).
 *
 * Pure functions, zero dependencies, minute granularity, bridge-process local
 * timezone. Invalid inputs are reported as `{ ok: false, reason }` with plain
 * English reason strings — i18n is left to the caller.
 */

/** Weekday in Monday-based numbering: 0 = Monday .. 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Schedule =
  | { type: "every"; intervalMs: number }
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekly"; day: Weekday; hour: number; minute: number }
  | { type: "monthly"; dayOfMonth: number; hour: number; minute: number };

export type ParseScheduleResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; reason: string };

export type ParseTimeoutResult = { ok: true; ms: number } | { ok: false; reason: string };

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const TIMEOUT_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

const WEEKDAYS: Record<string, Weekday> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

/** Parse a schedule string; case-insensitive, leading/trailing whitespace tolerated. */
export function parseSchedule(input: string): ParseScheduleResult {
  const parts = input.trim().toLowerCase().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") {
    return { ok: false, reason: "schedule is empty" };
  }
  switch (parts[0]) {
    case "every":
      return parseEvery(parts);
    case "daily":
      return parseDaily(parts);
    case "weekly":
      return parseWeekly(parts);
    case "monthly":
      return parseMonthly(parts);
    default:
      return { ok: false, reason: `unknown schedule type "${parts[0]}"` };
  }
}

/** Compute the next trigger time strictly after `from`, in the local timezone. */
export function nextRun(schedule: Schedule, from: Date): Date {
  switch (schedule.type) {
    case "every": {
      // Anchored semantics: from + interval.
      return new Date(from.getTime() + schedule.intervalMs);
    }
    case "daily": {
      const d = new Date(from);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      if (d.getTime() <= from.getTime()) {
        d.setDate(d.getDate() + 1);
      }
      return d;
    }
    case "weekly": {
      const d = new Date(from);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      // Convert JS getDay() (0 = Sunday) to Monday-based numbering.
      const fromDay = (d.getDay() + 6) % 7;
      let diff = schedule.day - fromDay;
      if (diff < 0) diff += 7;
      if (diff === 0 && d.getTime() <= from.getTime()) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
    case "monthly": {
      const y = from.getFullYear();
      const m = from.getMonth();
      const candidate = monthlyCandidate(y, m, schedule);
      if (candidate.getTime() > from.getTime()) return candidate;
      // Current month's candidate is at or before `from` — move to next month
      // (whose candidate is always strictly in the future).
      const nextTotal = y * 12 + m + 1;
      return monthlyCandidate(
        Math.floor(nextTotal / 12),
        nextTotal % 12,
        schedule,
      );
    }
  }
}

/** Parse a timeout duration ("10m", "1h", "90s") into milliseconds. */
export function parseTimeout(input: string): ParseTimeoutResult {
  const s = input.trim().toLowerCase();
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) {
    return { ok: false, reason: `invalid timeout "${input}" — expected like "10m", "1h" or "90s"` };
  }
  const n = Number(m[1]);
  if (n < 1) {
    return { ok: false, reason: "timeout must be at least 1" };
  }
  return { ok: true, ms: n * TIMEOUT_UNIT_MS[m[2] as keyof typeof TIMEOUT_UNIT_MS] };
}

function parseEvery(parts: string[]): ParseScheduleResult {
  if (parts.length !== 2) {
    return { ok: false, reason: `"every" expects one interval, e.g. "every 5m"` };
  }
  const m = /^(\d+)([mhd])$/.exec(parts[1]);
  if (!m) {
    return { ok: false, reason: `invalid interval "${parts[1]}" — expected <n>m, <n>h or <n>d` };
  }
  const n = Number(m[1]);
  if (n < 1) {
    return { ok: false, reason: "interval must be at least 1" };
  }
  const intervalMs = n * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return { ok: true, schedule: { type: "every", intervalMs } };
}

function parseDaily(parts: string[]): ParseScheduleResult {
  if (parts.length !== 2) {
    return { ok: false, reason: `"daily" expects a time, e.g. "daily 09:00"` };
  }
  const t = parseTime(parts[1]);
  if (!t) {
    return { ok: false, reason: `invalid time "${parts[1]}" — expected HH:MM` };
  }
  return { ok: true, schedule: { type: "daily", hour: t.hour, minute: t.minute } };
}

function parseWeekly(parts: string[]): ParseScheduleResult {
  if (parts.length !== 3) {
    return { ok: false, reason: `"weekly" expects a day and time, e.g. "weekly mon 09:00"` };
  }
  const day = WEEKDAYS[parts[1]];
  if (day === undefined) {
    return { ok: false, reason: `unknown weekday "${parts[1]}"` };
  }
  const t = parseTime(parts[2]);
  if (!t) {
    return { ok: false, reason: `invalid time "${parts[2]}" — expected HH:MM` };
  }
  return { ok: true, schedule: { type: "weekly", day, hour: t.hour, minute: t.minute } };
}

function parseMonthly(parts: string[]): ParseScheduleResult {
  if (parts.length !== 3) {
    return { ok: false, reason: `"monthly" expects a day-of-month and time, e.g. "monthly 15 09:00"` };
  }
  const dayOfMonth = Number(parts[1]);
  if (!/^\d+$/.test(parts[1]) || dayOfMonth < 1 || dayOfMonth > 31) {
    return { ok: false, reason: `invalid day-of-month "${parts[1]}" — expected 1..31` };
  }
  const t = parseTime(parts[2]);
  if (!t) {
    return { ok: false, reason: `invalid time "${parts[2]}" — expected HH:MM` };
  }
  return { ok: true, schedule: { type: "monthly", dayOfMonth, hour: t.hour, minute: t.minute } };
}

/** Parse HH:MM (lenient digit counts), validating hour 0-23 and minute 0-59. */
function parseTime(raw: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Candidate trigger for a given (year, month) — day clamped to month length. */
function monthlyCandidate(year: number, month: number, schedule: Schedule & { type: "monthly" }): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(schedule.dayOfMonth, daysInMonth);
  return new Date(year, month, day, schedule.hour, schedule.minute, 0, 0);
}
