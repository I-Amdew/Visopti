import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../net/rateLimiter";

describe("RateLimiter", () => {
  it("schedules tasks at the configured qps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter({ qps: 2, burst: 1, jitterRatio: 0 });
    const starts: number[] = [];

    const tasks = Array.from({ length: 3 }, () =>
      limiter.schedule(() => {
        starts.push(Date.now());
        return "ok";
      })
    );

    await vi.advanceTimersByTimeAsync(1200);
    await Promise.all(tasks);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThanOrEqual(500);
    expect(starts[1]).toBeLessThanOrEqual(505);
    expect(starts[2]).toBeGreaterThanOrEqual(1000);
    expect(starts[2]).toBeLessThanOrEqual(1005);
    vi.useRealTimers();
  });
});
