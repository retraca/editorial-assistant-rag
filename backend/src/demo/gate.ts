import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * What stands between a public URL and someone else's API bill.
 *
 * The local build documents having neither authentication nor rate limiting,
 * which is honest and fine for a tool that only ever listens on localhost. A link
 * that can be handed to a tester is the case that entry said would need both, so
 * this is that entry answered rather than restated.
 *
 * A single shared password, not accounts. The question being answered is "may
 * this person use it", not "who is this person", and inventing a user table to
 * answer the first would be building the wrong thing. Both controls are inert
 * when their environment variables are unset, so nothing here changes how the
 * local build runs.
 */

const COOKIE = 'ea_pass';

/** Timing-safe, because a shared secret compared with === leaks its prefix. */
const matches = (given: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(config.demo.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** The value the cookie carries: a keyed digest, so it cannot be forged. */
const token = () =>
  crypto.createHmac('sha256', config.demo.password).update('editorial-assistant').digest('hex');

export const gateOn = () => Boolean(config.demo.password);

export function authorised(req: FastifyRequest): boolean {
  if (!gateOn()) return true;
  const cookie = (req.headers.cookie ?? '')
    .split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];
  return cookie === token();
}

export function grant(reply: FastifyReply) {
  reply.header('Set-Cookie',
    `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

export const checkPassword = (given: string) =>
  Boolean(given) && Boolean(config.demo.password) && matches(given);

/**
 * A ceiling per visitor per hour, counted only on questions.
 *
 * Reading a chapter or listing books costs nothing and is not counted; an
 * answer costs a real amount of money and is. The window is a plain sliding
 * count in memory: a restart forgives everyone, which is the right failure mode
 * for a demo and the wrong one for anything with a billing relationship.
 */
const seen = new Map<string, number[]>();

export function withinLimit(visitor: string): { ok: boolean; used: number; limit: number } {
  const limit = config.demo.questionsPerHour;
  if (!limit) return { ok: true, used: 0, limit: 0 };
  const cutoff = Date.now() - 3600_000;
  const hits = (seen.get(visitor) ?? []).filter((t) => t > cutoff);
  seen.set(visitor, hits);
  return { ok: hits.length < limit, used: hits.length, limit };
}

export function recordQuestion(visitor: string) {
  if (!config.demo.questionsPerHour) return;
  const hits = seen.get(visitor) ?? [];
  hits.push(Date.now());
  seen.set(visitor, hits);
}

/**
 * A stable id for someone without asking them to identify themselves.
 *
 * Threads have to come back on a reload, and the rate limit has to attach to
 * somebody, but neither needs a name. A random id is minted on first contact and
 * kept in a cookie: enough to be consistent for one person, and useless as a
 * record of who they are.
 */
const VISITOR = 'ea_visitor';

export function visitorId(req: FastifyRequest, reply: FastifyReply): string {
  const existing = (req.headers.cookie ?? '')
    .split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === VISITOR)?.[1];
  if (existing && /^[a-f0-9]{16}$/.test(existing)) return existing;
  const fresh = crypto.randomBytes(8).toString('hex');
  reply.header('Set-Cookie',
    `${VISITOR}=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
  return fresh;
}
