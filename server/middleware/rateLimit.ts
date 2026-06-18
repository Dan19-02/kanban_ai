import rateLimit from "express-rate-limit";

/** General API limiter — generous, guards against runaway clients. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

/** Strict limiter for auth endpoints to blunt credential-stuffing/brute force. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't count successful logins/registrations against the limit.
  skipSuccessfulRequests: true,
  message: { error: "Too many attempts. Please try again later." },
});

/** Limiter for the expensive AI analysis endpoint. */
export const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You're analyzing too frequently. Please wait a moment." },
});
