import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Write-action bookkeeping on an injected SQLite handle (the server passes the shared db,
 * tests a temp file): quota reservations, per-item batch state and the sequential runner
 * used by apply_execute / connect_execute. No browser and no global db in here.
 */

export type ActionKind = "apply" | "connect" | "message";
export type Limits = { apply_daily: number; connect_daily: number; connect_weekly: number; message_daily: number };

/**
 * Rows that hold a quota slot and block a repeat on the same target.
 * 'unverified' = the submit/send click happened but success could not be confirmed: it may have gone out.
 */
const HOLDING = "('pending','done','unverified')";
/** How far back an earlier action on the same target blocks a new one (0 = never). */
const DEDUPE_DAYS: Record<ActionKind, number> = { apply: 3650, connect: 90, message: 0 };

/** Account-level errors: stop the whole batch, never continue to the next item. */
export const ACCOUNT_LEVEL = /^(CHECKPOINT|RATE_LIMITED|SUSPENDED|READ_BUDGET|LOGGED_OUT|LEFT_LINKEDIN|PROFILE_BUSY|BROWSER_LAUNCH_FAILED|EDGE_LAUNCH_FAILED|DISCARD_FAILED|NOTE_LIMIT)/;

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

/** BEGIN IMMEDIATE ... COMMIT; a failing ROLLBACK never masks the original error. */
export function tx<T>(d: DatabaseSync, fn: () => T): T {
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      d.exec("ROLLBACK");
    } catch {
      // no transaction left (e.g. COMMIT already ended it): keep the original error
    }
    throw e;
  }
}

// ---- quota ----

/** Rolling windows (UTC timestamps written by SQLite). Pending and unverified rows count too. */
export function countSince(d: DatabaseSync, type: string, modifier: string): number {
  const row = d
    .prepare(`SELECT COUNT(*) c FROM actions WHERE type=? AND status IN ${HOLDING} AND ts >= datetime('now', ?)`)
    .get(type, modifier) as { c: number };
  return row.c;
}

export function quotaStatusIn(d: DatabaseSync, limits: Limits) {
  return {
    apply: { used_24h: countSince(d, "apply", "-1 day"), limit_24h: limits.apply_daily },
    connect: {
      used_24h: countSince(d, "connect", "-1 day"),
      limit_24h: limits.connect_daily,
      used_7d: countSince(d, "connect", "-7 day"),
      limit_7d: limits.connect_weekly,
    },
    message: { used_24h: countSince(d, "message", "-1 day"), limit_24h: limits.message_daily },
  };
}

export function remainingIn(d: DatabaseSync, limits: Limits, kind: ActionKind): number {
  const q = quotaStatusIn(d, limits);
  if (kind === "apply") return Math.max(0, q.apply.limit_24h - q.apply.used_24h);
  if (kind === "message") return Math.max(0, q.message.limit_24h - q.message.used_24h);
  return Math.max(0, Math.min(q.connect.limit_24h - q.connect.used_24h, q.connect.limit_7d - q.connect.used_7d));
}

/** Status of an earlier pending/done/unverified action on this target inside the dedupe window, if any. */
export function activeAction(d: DatabaseSync, kind: ActionKind, target: string): string | undefined {
  const days = DEDUPE_DAYS[kind];
  if (!days) return undefined;
  const row = d
    .prepare(`SELECT status FROM actions WHERE type=? AND target=? AND status IN ${HOLDING} AND ts >= datetime('now', ?) ORDER BY id DESC LIMIT 1`)
    .get(kind, target, `-${days} day`) as { status: string } | undefined;
  return row?.status;
}

/** Messages: an earlier one to the same person in this window blocks a new one (explicit, not DEDUPE_DAYS). */
export const MESSAGE_REPEAT_DAYS = 7;
/** Reason prefix of a message that failed AFTER text was typed into the composer (it blocks a repeat too). */
export const TYPED_REASON = "typed_";

/**
 * Status of an earlier message to `target` in the last `days` that blocks a new one: pending/done/unverified,
 * or failed after typing (withReservation stores "failed: typed_..."). A failure before typing does not block.
 */
export function recentMessageIn(d: DatabaseSync, target: string, days = MESSAGE_REPEAT_DAYS): string | undefined {
  const rows = d
    .prepare(`SELECT status, detail FROM actions WHERE type='message' AND target=? AND ts >= datetime('now', ?) ORDER BY id DESC`)
    .all(target, `-${days} day`) as { status: string; detail: string | null }[];
  const hit = rows.find((r) => ["pending", "done", "unverified"].includes(r.status) || (r.status === "failed" && (r.detail ?? "").startsWith(`failed: ${TYPED_REASON}`)));
  return hit ? (hit.status === "failed" ? "failed after typing" : hit.status) : undefined;
}

export type Reservation = { ok: true; id: number } | { ok: false; reason: "quota" | "duplicate"; detail?: string };

/**
 * Atomically reserves one action slot (status 'pending'). Refuses when the quota is spent or the
 * same target already has a pending/done/unverified action. Callers settle it with finishIn.
 */
export function reserveIn(d: DatabaseSync, limits: Limits, kind: ActionKind, target: string): Reservation {
  return tx(d, (): Reservation => {
    const prior = activeAction(d, kind, target);
    if (prior) return { ok: false, reason: "duplicate", detail: `an earlier ${kind} for this target is ${prior}` };
    if (remainingIn(d, limits, kind) < 1) return { ok: false, reason: "quota" };
    const r = d.prepare(`INSERT INTO actions (type,target,status) VALUES (?,?,'pending')`).run(kind, target);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
}

/** Settles a reservation; `onDone` (e.g. jobs.applied=1) runs in the same transaction. */
export function finishIn(d: DatabaseSync, id: number, status: "done" | "failed" | "unverified", detail = "", onDone?: () => void) {
  tx(d, () => {
    if (status === "done") onDone?.();
    d.prepare(`UPDATE actions SET status=?, detail=? WHERE id=?`).run(status, detail.slice(0, 500), id);
  });
}

/**
 * Reservations still 'pending' after `minutes` belong to a process that died mid-action. The click may
 * have happened, so they become 'unverified' (still counted, still block a repeat), never silently freed.
 */
export function sweepStaleIn(d: DatabaseSync, minutes = 10): number {
  return Number(
    d
      .prepare(`UPDATE actions SET status='unverified', detail=TRIM(COALESCE(detail,'') || ' stale_pending: process ended mid-action') WHERE status='pending' AND ts < datetime('now', ?)`)
      .run(`-${minutes} minutes`).changes,
  );
}

// ---- batches (per-item state) ----

/** open = can be executed; claimed = an execute call is working on it; the rest are final. */
export type ItemState = "open" | "claimed" | "done" | "failed" | "unverified" | "skipped";
export type BatchData = { ids: string[]; state: Record<string, ItemState>; meta?: Record<string, unknown> };

/** Batch rows written before per-item state stored a plain JSON array of ids. */
export function parseBatch(items: string): BatchData {
  const raw = JSON.parse(items) as unknown;
  if (Array.isArray(raw)) return { ids: raw.map(String), state: Object.fromEntries(raw.map((x) => [String(x), "open" as ItemState])) };
  const b = raw as BatchData;
  const state = { ...(b.state ?? {}) };
  for (const id of b.ids) state[id] ??= "open";
  return { ids: b.ids, state, meta: b.meta };
}

export function newBatch(d: DatabaseSync, kind: string, ids: string[], meta?: Record<string, unknown>): string {
  const id = randomUUID();
  const data: BatchData = { ids, state: Object.fromEntries(ids.map((x) => [x, "open" as ItemState])), meta };
  d.prepare(`INSERT INTO batches (id,kind,items) VALUES (?,?,?)`).run(id, kind, JSON.stringify(data));
  return id;
}

type ClaimArgs = { batchId: string; kind: string; ids: string[]; ttlMin: number; prepareTool: string };

/** Batch checks shared by claimItems and checkItems: known, fresh, not used up, every id in it and still open. */
function claimable(d: DatabaseSync, o: ClaimArgs): BatchData {
  const row = d
    .prepare(`SELECT items, used, created_at >= datetime('now', ?) AS fresh FROM batches WHERE id=? AND kind=?`)
    .get(`-${o.ttlMin} minutes`, o.batchId, o.kind) as { items: string; used: number; fresh: number } | undefined;
  if (!row) throw new Error(`Unknown batch_id. Run ${o.prepareTool} first.`);
  if (!row.fresh) throw new Error(`Batch expired (> ${o.ttlMin} min). Run ${o.prepareTool} again.`);
  const b = parseBatch(row.items);
  if (row.used && !b.ids.some((x) => b.state[x] === "open")) throw new Error(`Batch already used up. Run ${o.prepareTool} again.`);
  const bad = o.ids.filter((x) => !b.ids.includes(x));
  if (bad.length) throw new Error(`Not in the batch: ${bad.join(", ")}`);
  const busy = o.ids.filter((x) => b.state[x] !== "open");
  if (busy.length) throw new Error(`Already processed or in progress in this batch: ${busy.map((x) => `${x} (${b.state[x]})`).join(", ")}`);
  return b;
}

/**
 * Validates the requested ids against the batch and the quota, and only then marks them 'claimed'.
 * Any validation error throws with the batch untouched, so a typo never burns the batch.
 */
export function claimItems(d: DatabaseSync, o: ClaimArgs & { quotaLeft: () => number }): BatchData {
  return tx(d, () => {
    const b = claimable(d, o);
    const left = o.quotaLeft();
    if (o.ids.length > left) throw new Error(`Quota: only ${left} ${o.kind} action(s) left in the rolling window; pick at most ${left}.`);
    for (const x of o.ids) b.state[x] = "claimed";
    writeBatch(d, o.batchId, b);
    return b;
  });
}

/** Same checks as claimItems without claiming anything or touching the quota (dry runs leave the batch usable). */
export function checkItems(d: DatabaseSync, o: ClaimArgs): BatchData {
  return claimable(d, o);
}

function writeBatch(d: DatabaseSync, batchId: string, b: BatchData) {
  const used = b.ids.some((x) => b.state[x] === "open") ? 0 : 1;
  d.prepare(`UPDATE batches SET items=?, used=? WHERE id=?`).run(JSON.stringify(b), used, batchId);
}

/**
 * Results that leave the item executable again in the same batch (nothing was sent). An account-level
 * error thrown before the submit (CHECKPOINT, LOGGED_OUT...) also reopens it: after a submit the
 * executors return unverified instead of throwing, so a "failed" with that reason never went out.
 */
export function reopens(r: Pick<ItemResult, "status" | "reason">): boolean {
  return (
    r.status === "not_attempted" || r.status === "needs_answer" || r.status === "dry_run_ok" || r.reason === "time_budget" || r.reason === "quota" ||
    (r.status === "failed" && ACCOUNT_LEVEL.test(r.reason ?? ""))
  );
}

/**
 * Writes each item's final state; unattempted ones go back to 'open'. `used` = nothing open is left.
 * Sliding TTL: a batch that just completed an item is still being worked through, so its clock
 * (created_at, what claimItems checks) restarts.
 */
export function settleItems(d: DatabaseSync, batchId: string, results: ItemResult[]) {
  tx(d, () => {
    const row = d.prepare(`SELECT items FROM batches WHERE id=?`).get(batchId) as { items: string } | undefined;
    if (!row) return;
    const b = parseBatch(row.items);
    for (const r of results) {
      if (!b.ids.includes(r.id)) continue;
      b.state[r.id] = reopens(r) ? "open" : (r.status as Exclude<ItemStatus, "needs_answer" | "not_attempted" | "dry_run_ok">);
    }
    writeBatch(d, batchId, b);
    if (results.some((r) => r.status === "done" && b.ids.includes(r.id))) d.prepare(`UPDATE batches SET created_at=CURRENT_TIMESTAMP WHERE id=?`).run(batchId);
  });
}

/** tracker_sync saw the job in LinkedIn's "applied" list: an unverified apply did go out. Returns rows changed. */
export function confirmUnverifiedApply(d: DatabaseSync, jobId: string): number {
  return Number(
    d.prepare(`UPDATE actions SET status='done', detail=TRIM(COALESCE(detail,'')||' confirmed by tracker') WHERE type='apply' AND target=? AND status='unverified'`).run(jobId).changes,
  );
}

// ---- sequential runner ----

/** dry_run_ok = a message dry run reached the composer and closed it; nothing was sent and the item stays open. */
export type ItemStatus = "done" | "failed" | "unverified" | "skipped" | "needs_answer" | "not_attempted" | "dry_run_ok";
/** What one item's executor returns. `stop` = stop the batch after this item (account-level problem). */
export type Outcome = { status: Exclude<ItemStatus, "not_attempted">; reason?: string; stop?: string };
export type ItemResult = { id: string; status: ItemStatus; success: boolean; reason?: string; stop?: string; [k: string]: unknown };

/**
 * Reserve -> act -> settle. The reservation always ends done/failed/unverified (try/finally), even when
 * `act` throws. `onDone` runs in the same transaction as the 'done' flip.
 */
export async function withReservation<O extends Outcome>(
  d: DatabaseSync,
  limits: Limits,
  kind: ActionKind,
  target: string,
  act: () => Promise<O>,
  onDone?: () => void,
): Promise<ItemResult> {
  const r = reserveIn(d, limits, kind, target);
  if (!r.ok) return { id: target, status: "skipped", success: false, reason: r.reason === "quota" ? "quota" : "already_done_or_pending", detail: r.detail };
  let final: "done" | "failed" | "unverified" = "failed";
  let detail = "exception";
  try {
    const o = await act();
    final = o.status === "done" ? "done" : o.status === "unverified" ? "unverified" : "failed";
    detail = [o.status, o.reason].filter(Boolean).join(": ");
    return { ...o, id: target, success: o.status === "done" };
  } catch (e) {
    detail = firstLine(e);
    throw e;
  } finally {
    // A failing settle (e.g. onDone's UPDATE) must not replace the real outcome: a sent application
    // reported as an exception could be retried. The row stays 'pending' and sweepStale makes it unverified.
    try {
      finishIn(d, r.id, final, detail, onDone);
    } catch (e) {
      console.error(`[ledger] could not settle action ${r.id} (${final}): ${firstLine(e)}`);
    }
  }
}

/**
 * Runs items one at a time. Before every item (the first included), `hasTime()` must allow one more,
 * otherwise the rest are returned as not_attempted. A thrown error fails only that item, except
 * account-level errors (and an item's `stop`), which stop the loop; earlier results are always kept.
 */
export async function runItems(
  ids: string[],
  step: (id: string) => Promise<ItemResult>,
  hasTime: () => boolean,
): Promise<{ results: ItemResult[]; stopped?: string }> {
  const results: ItemResult[] = [];
  let stopped: string | undefined;
  for (const id of ids) {
    if (stopped) {
      results.push({ id, status: "not_attempted", success: false, reason: "batch_stopped" });
      continue;
    }
    if (!hasTime()) {
      results.push({ id, status: "not_attempted", success: false, reason: "time_budget" });
      continue;
    }
    try {
      const { stop, ...r } = await step(id);
      results.push(r);
      if (stop) stopped = stop;
    } catch (e) {
      const msg = firstLine(e);
      results.push({ id, status: "failed", success: false, reason: msg });
      if (ACCOUNT_LEVEL.test(msg)) stopped = msg;
    }
  }
  return { results, stopped };
}

/** Counts per status, for the tool response. */
export function summarize(results: ItemResult[]) {
  const by: Partial<Record<ItemStatus, number>> = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  return by;
}
