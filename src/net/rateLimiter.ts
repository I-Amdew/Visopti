type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface RateLimiterOptions {
  qps: number;
  burst: number;
  jitterRatio?: number;
  clock?: () => number;
  setTimeoutFn?: typeof setTimeout;
}

interface ScheduledTask<T> {
  fn: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class RateLimiter {
  private qps: number;
  private burst: number;
  private jitterRatio: number;
  private clock: () => number;
  private setTimeoutFn: typeof setTimeout;
  private tokens: number;
  private lastRefillMs: number;
  private queue: Array<ScheduledTask<unknown>>;
  private timer: TimeoutHandle | null;
  private pumping: boolean;

  constructor(options: RateLimiterOptions) {
    this.qps = Math.max(0.01, options.qps);
    this.burst = Math.max(1, Math.floor(options.burst));
    this.jitterRatio = Math.max(0, options.jitterRatio ?? 0.25);
    this.clock = options.clock ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.tokens = this.burst;
    this.lastRefillMs = this.clock();
    this.queue = [];
    this.timer = null;
    this.pumping = false;
  }

  getQps(): number {
    return this.qps;
  }

  setQps(newQps: number): void {
    this.qps = Math.max(0.01, newQps);
    this.refillTokens();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedulePump(0);
  }

  schedule<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  private refillTokens(): void {
    const now = this.clock();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    const refill = (elapsedMs / 1000) * this.qps;
    if (refill > 0) {
      this.tokens = Math.min(this.burst, this.tokens + refill);
      this.lastRefillMs = now;
    }
  }

  private computeJitterDelayMs(): number {
    if (this.jitterRatio <= 0) {
      return 0;
    }
    const intervalMs = 1000 / this.qps;
    return Math.random() * intervalMs * this.jitterRatio;
  }

  private timeUntilNextTokenMs(): number {
    this.refillTokens();
    if (this.tokens >= 1) {
      return 0;
    }
    const missing = 1 - this.tokens;
    return Math.max(0, (missing / this.qps) * 1000);
  }

  private schedulePump(delayMs: number): void {
    if (this.timer) {
      return;
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    while (this.queue.length > 0) {
      this.refillTokens();
      if (this.tokens < 1) {
        this.schedulePump(this.timeUntilNextTokenMs());
        break;
      }
      const task = this.queue.shift() as ScheduledTask<unknown>;
      this.tokens -= 1;
      const delayMs = this.computeJitterDelayMs();
      this.setTimeoutFn(() => {
        Promise.resolve()
          .then(task.fn)
          .then(task.resolve)
          .catch(task.reject);
      }, delayMs);
    }
    this.pumping = false;
  }
}
