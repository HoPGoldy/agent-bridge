import { describe, expect, it } from "vitest";
import { nextRun, parseSchedule, parseTimeout, type Schedule } from "./grammar";

/** Local-time Date constructor shorthand (months are 0-indexed). */
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): Date =>
  new Date(y, m, d, h, min, s);

function unwrap(r: ReturnType<typeof parseSchedule>): Schedule {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.schedule;
}

describe("parseSchedule", () => {
  it("parses every <n><unit>", () => {
    expect(parseSchedule("every 5m")).toEqual({
      ok: true,
      schedule: { type: "every", intervalMs: 5 * 60_000 },
    });
    expect(parseSchedule("EVERY 2H")).toEqual({
      ok: true,
      schedule: { type: "every", intervalMs: 2 * 3_600_000 },
    });
    expect(parseSchedule(" every 1d ")).toEqual({
      ok: true,
      schedule: { type: "every", intervalMs: 86_400_000 },
    });
  });

  it("parses daily HH:MM", () => {
    expect(parseSchedule("daily 09:00")).toEqual({
      ok: true,
      schedule: { type: "daily", hour: 9, minute: 0 },
    });
    expect(parseSchedule("Daily 23:59")).toEqual({
      ok: true,
      schedule: { type: "daily", hour: 23, minute: 59 },
    });
  });

  it("parses weekly <day> HH:MM (case-insensitive)", () => {
    expect(parseSchedule("weekly mon 10:30")).toEqual({
      ok: true,
      schedule: { type: "weekly", day: 0, hour: 10, minute: 30 },
    });
    expect(parseSchedule("WEEKLY SUN 00:00")).toEqual({
      ok: true,
      schedule: { type: "weekly", day: 6, hour: 0, minute: 0 },
    });
  });

  it("parses monthly <day-of-month> HH:MM", () => {
    expect(parseSchedule("monthly 31 09:00")).toEqual({
      ok: true,
      schedule: { type: "monthly", dayOfMonth: 31, hour: 9, minute: 0 },
    });
    expect(parseSchedule("monthly 1 12:00")).toEqual({
      ok: true,
      schedule: { type: "monthly", dayOfMonth: 1, hour: 12, minute: 0 },
    });
  });

  it("rejects invalid input", () => {
    const bad = [
      "", // empty
      "   ",
      "every 0m", // n >= 1
      "every -5m", // negative
      "every 5x", // unknown unit
      "every 5", // missing unit
      "every 5m extra", // extra fields
      "daily 25:00", // hour out of range
      "daily 09:60", // minute out of range
      "daily 9:00 extra", // extra fields
      "daily", // missing time
      "weekly xday 10:00", // unknown day
      "weekly mon", // missing time
      "weekly mon 10:00 extra", // extra fields
      "monthly 0 09:00", // day-of-month < 1
      "monthly 32 09:00", // day-of-month > 31
      "monthly 31", // missing time
      "foo 5m", // unknown type
      "dailyy 09:00", // unknown type
    ];
    for (const input of bad) {
      const r = parseSchedule(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("nextRun", () => {
  it("every: anchored at from + interval", () => {
    const m = unwrap(parseSchedule("every 30m"));
    expect(nextRun(m, at(2024, 0, 1, 10, 0))).toEqual(at(2024, 0, 1, 10, 30));

    const h = unwrap(parseSchedule("every 2h"));
    expect(nextRun(h, at(2024, 0, 1, 23, 0))).toEqual(at(2024, 0, 2, 1, 0));

    const d = unwrap(parseSchedule("every 1d"));
    expect(nextRun(d, at(2024, 0, 1, 8, 0))).toEqual(at(2024, 0, 2, 8, 0));
  });

  it("daily: same day if before, next day if at or past the trigger", () => {
    const s = unwrap(parseSchedule("daily 10:00"));
    expect(nextRun(s, at(2024, 0, 1, 9, 59))).toEqual(at(2024, 0, 1, 10, 0));
    expect(nextRun(s, at(2024, 0, 1, 10, 0))).toEqual(at(2024, 0, 2, 10, 0)); // exactly equal -> next day
    expect(nextRun(s, at(2024, 0, 1, 10, 1))).toEqual(at(2024, 0, 2, 10, 0));
    expect(nextRun(s, at(2024, 0, 31, 23, 59))).toEqual(at(2024, 1, 1, 10, 0)); // month rollover
  });

  it("weekly: next occurrence of the weekday (2024-01-01 is a Monday)", () => {
    const s = unwrap(parseSchedule("weekly wed 10:00"));
    expect(nextRun(s, at(2024, 0, 1, 0, 0))).toEqual(at(2024, 0, 3, 10, 0));
    expect(nextRun(s, at(2024, 0, 3, 10, 0))).toEqual(at(2024, 0, 10, 10, 0)); // exactly at -> next week
    expect(nextRun(s, at(2024, 0, 5, 12, 0))).toEqual(at(2024, 0, 10, 10, 0)); // Friday -> next Wed
  });

  it("weekly: wraps around the week", () => {
    const s = unwrap(parseSchedule("weekly mon 09:00"));
    expect(nextRun(s, at(2024, 0, 7, 8, 0))).toEqual(at(2024, 0, 8, 9, 0)); // Sunday -> Monday
  });

  it("monthly: clamps day 31 in short months (leap and common years)", () => {
    const s = unwrap(parseSchedule("monthly 31 10:00"));
    // January has 31 days -> unclamped
    expect(nextRun(s, at(2024, 0, 15, 0, 0))).toEqual(at(2024, 0, 31, 10, 0));
    // Feb 2024 (leap year) -> Feb 29
    expect(nextRun(s, at(2024, 1, 15, 0, 0))).toEqual(at(2024, 1, 29, 10, 0));
    // Feb 2023 (common year) -> Feb 28
    expect(nextRun(s, at(2023, 1, 15, 0, 0))).toEqual(at(2023, 1, 28, 10, 0));
    // from exactly at the clamped candidate -> next month
    expect(nextRun(s, at(2024, 1, 29, 10, 0))).toEqual(at(2024, 2, 31, 10, 0));
  });

  it("monthly: regular days and year rollover", () => {
    const s = unwrap(parseSchedule("monthly 15 08:30"));
    expect(nextRun(s, at(2024, 0, 1, 0, 0))).toEqual(at(2024, 0, 15, 8, 30));
    expect(nextRun(s, at(2024, 0, 15, 8, 30))).toEqual(at(2024, 1, 15, 8, 30)); // exactly at -> next month
    expect(nextRun(s, at(2024, 11, 16, 0, 0))).toEqual(at(2025, 0, 15, 8, 30)); // Dec -> Jan next year
  });
});

describe("parseTimeout", () => {
  it("parses valid inputs", () => {
    expect(parseTimeout("10m")).toEqual({ ok: true, ms: 600_000 });
    expect(parseTimeout("1h")).toEqual({ ok: true, ms: 3_600_000 });
    expect(parseTimeout("90s")).toEqual({ ok: true, ms: 90_000 });
    expect(parseTimeout(" 5m ")).toEqual({ ok: true, ms: 300_000 });
  });

  it("rejects invalid inputs", () => {
    const bad = ["", "0m", "-5m", "10", "10x", "1.5h", "10 m", "abc"];
    for (const input of bad) {
      const r = parseTimeout(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
