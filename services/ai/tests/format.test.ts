import { describe, expect, it } from "vite-plus/test";

import type { UsageDay } from "../web/src/api.ts";
import { byDay, byUser, count, ms, total } from "../web/src/format.ts";

const row = (day: string, sub: string, n: number): UsageDay => ({
  day,
  sub,
  requests: 1,
  promptTokens: n,
  cachedTokens: n / 2,
  outputTokens: n * 2,
});

describe("format", () => {
  it("abbreviates large counts and keeps small ones exact", () => {
    expect(count(950)).toBe("950");
    expect(count(12_345)).toBe("12.3K");
    expect(count(2_500_000)).toBe("2.50M");
    expect(count(null)).toBe("–");
    expect(ms(250.4)).toBe("250 ms");
    expect(ms(1520)).toBe("1.52 s");
  });

  it("sums usage per day, newest first, and per user, largest first", () => {
    const rows = [
      row("2026-11-26", "a", 10),
      row("2026-11-27", "a", 20),
      row("2026-11-27", "b", 40),
    ];
    expect(byDay(rows).map(([day, t]) => [day, t.requests, t.promptTokens])).toEqual([
      ["2026-11-27", 2, 60],
      ["2026-11-26", 1, 10],
    ]);
    expect(byUser(rows).map(([sub, t]) => [sub, t.outputTokens])).toEqual([
      ["b", 80],
      ["a", 60],
    ]);
    expect(total(rows)).toEqual({
      requests: 3,
      promptTokens: 70,
      cachedTokens: 35,
      outputTokens: 140,
    });
  });
});
