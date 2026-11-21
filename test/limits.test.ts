import { describe, expect, it } from "vitest";
import { countRuns, startOfDay } from "../src/router/limits.js";

describe("countRuns", () => {
  it("counts today's task runs and this subject's, leaving out skipped runs, commands and this run", () => {
    const runs = [
      { id: 1, title: "factory · agent:implement · #42", conclusion: "success" },
      { id: 2, title: "factory · agent:review · #7", conclusion: "failure" },
      { id: 3, title: "factory · bug · #42", conclusion: "skipped" },
      { id: 4, title: "factory · show-config", conclusion: "success" },
      { id: 5, title: "factory · agent:implement · #420", conclusion: "success" },
      { id: 6, title: "factory · agent:implement · #42", conclusion: null },
    ];

    expect(countRuns(runs, 42, 6)).toEqual({ today: 3, subjectToday: 1 });
  });
});

describe("startOfDay", () => {
  it("is local midnight in the repo's time zone", () => {
    const now = new Date("2026-11-21T03:30:00Z");

    expect(startOfDay(now, "UTC")).toBe("2026-11-21T00:00:00.000Z");
    expect(startOfDay(now, "America/New_York")).toBe("2026-11-20T05:00:00.000Z");
    expect(startOfDay(now, "Asia/Tokyo")).toBe("2026-11-20T15:00:00.000Z");
  });
});
