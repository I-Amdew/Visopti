import { RateLimiter } from "./rateLimiter";

export const openMeteoRateLimiter = new RateLimiter({
  qps: 2,
  burst: 2,
  jitterRatio: 0.3
});
