import { config } from "../config.js";
import { db } from "../store/db.js";
import { activeAction, finishIn, quotaStatusIn, remainingIn, reserveIn, sweepStaleIn, type ActionKind, type Reservation } from "./ledger.js";

export type { ActionKind } from "./ledger.js";

/** Rolling windows (last 24h / 7d). Pending and unverified reservations count too. Logic in ledger.ts. */
export function quotaStatus() {
  return quotaStatusIn(db, config.limits);
}

/** How many more actions of this kind are allowed right now. */
export function remaining(kind: ActionKind): number {
  return remainingIn(db, config.limits, kind);
}

/**
 * Atomically reserves one action slot (status 'pending'); refuses when the quota is spent or the target
 * already has a pending/done/unverified action. Callers settle it with finishReservation.
 */
export function reserve(kind: ActionKind, target: string): Reservation {
  return reserveIn(db, config.limits, kind, target);
}

export function finishReservation(id: number, status: "done" | "failed" | "unverified", detail = "", onDone?: () => void) {
  finishIn(db, id, status, detail, onDone);
}

/** Existing pending/done/unverified action on this target (used by the *_prepare tools to hide it). */
export function priorAction(kind: ActionKind, target: string): string | undefined {
  return activeAction(db, kind, target);
}

/** Startup: reservations left 'pending' by a crashed process become 'unverified'. */
export function sweepStalePending(minutes = 10): number {
  return sweepStaleIn(db, minutes);
}
