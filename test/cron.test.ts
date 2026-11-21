import { describe, expect, it } from "vitest";
import { latestSlot, parseCron } from "../src/router/cron.js";

const slot = (cron: string, tz: string, after: string, upTo: string) =>
  latestSlot(parseCron(cron), tz, new Date(after), new Date(upTo))?.toISOString();

describe("latestSlot", () => {
  it("finds the slot inside a 15-minute tick window", () => {
    expect(slot("0 9 * * *", "UTC", "2026-11-20T08:50:00Z", "2026-11-20T09:05:00Z")).toBe("2026-11-20T09:00:00.000Z");
  });

  it("finds nothing when the window holds no slot, and excludes the window's start", () => {
    expect(slot("0 9 * * *", "UTC", "2026-11-20T09:05:00Z", "2026-11-20T09:20:00Z")).toBeUndefined();
    expect(slot("0 9 * * *", "UTC", "2026-11-20T09:00:00Z", "2026-11-20T09:10:00Z")).toBeUndefined();
  });

  it("reads the cron in the repo's time zone, across a DST change", () => {
    // 09:00 in New York is 14:00 UTC in winter and 13:00 UTC in summer.
    expect(slot("0 9 * * *", "America/New_York", "2026-11-20T13:50:00Z", "2026-11-20T14:05:00Z")).toBe("2026-11-20T14:00:00.000Z");
    expect(slot("0 9 * * *", "America/New_York", "2026-07-20T12:50:00Z", "2026-07-20T13:05:00Z")).toBe("2026-07-20T13:00:00.000Z");
  });

  it("returns only the latest of several missed slots", () => {
    expect(slot("0 * * * *", "UTC", "2026-11-20T03:10:00Z", "2026-11-20T09:20:00Z")).toBe("2026-11-20T09:00:00.000Z");
  });

  it("supports names, ranges, steps and lists, with day-of-month OR day-of-week when both are set", () => {
    // Weekdays at 08:30. 2026-11-21 is a Saturday, so the latest slot is Friday's.
    expect(slot("30 8 * * MON-FRI", "UTC", "2026-11-18T00:00:00Z", "2026-11-21T12:00:00Z")).toBe("2026-11-20T08:30:00.000Z");
    // The 1st of the month, or any Sunday: Sunday 2026-11-15 beats Sunday-less days since.
    expect(slot("0 0 1 * SUN", "UTC", "2026-11-10T00:00:00Z", "2026-11-21T12:00:00Z")).toBe("2026-11-15T00:00:00.000Z");
    expect(slot("*/20 6,18 * jan-dec 7", "UTC", "2026-11-15T17:00:00Z", "2026-11-15T19:00:00Z")).toBe("2026-11-15T18:40:00.000Z");
  });

  it("looks back no more than 31 days", () => {
    expect(slot("0 0 1 1 *", "UTC", "2020-01-01T00:00:00Z", "2026-11-21T00:00:00Z")).toBeUndefined();
  });
});

describe("parseCron", () => {
  it("rejects values a cron can't hold", () => {
    expect(() => parseCron("60 * * * *")).toThrow("60 isn't a valid minute");
    expect(() => parseCron("* * * * funday")).toThrow("funday isn't a valid day of week");
    expect(() => parseCron("*/0 * * * *")).toThrow("bad step");
    expect(() => parseCron("* * *")).toThrow("five fields");
  });
});
