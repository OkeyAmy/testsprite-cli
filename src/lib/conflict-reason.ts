/**
 * Why a case landed in a run response's `conflicts[]` instead of dispatching.
 * The backend (`batchRunFresh` / `dispatchTestListGroups`) tags each conflict so
 * the CLI stops rendering every non-dispatch as "already in flight" — which is
 * wrong for a view-only mirror, an un-runnable environment, or an unknown id.
 *
 * Absent ⇒ a legacy / pre-discriminator backend: treated as `in_flight` (the
 * historical rendering) for backward compatibility.
 *
 * `insufficient_credits` / `paused` (or `billing_hold`, the deprecated spelling
 * older backends send) are billing refusals the backend folds
 * into `conflicts[]` for a MIXED batch (some cases dispatched, some refused). A
 * batch where nothing dispatched and every refusal was credits comes back as a
 * plain 402 `INSUFFICIENT_CREDITS` envelope instead — the same shape the
 * single-run route answers — so both surfaces exit 12.
 */
import { ApiError, insufficientCreditsNextAction } from './errors.js';
import { classifyBillingRefusal, isPausedReason } from './billing-refusal.js';

export type ConflictReason =
  | 'in_flight'
  | 'mcp_view_only'
  | 'local_address'
  | 'not_found'
  | 'insufficient_credits'
  | 'paused'
  /** Deprecated spelling of `paused`, still sent by older backends. */
  | 'billing_hold'
  | 'error';

/** A conflict entry on a run response. `message` carries actionable detail for
 * `local_address` / `insufficient_credits` / `paused` / `error` (the
 * backend's nextAction). */
export interface RunConflict {
  testId: string;
  currentRunId?: string;
  reason?: ConflictReason;
  message?: string;
}

/**
 * Short human label for a conflict's cause — the reason a case did NOT dispatch.
 * Absent reason renders as the legacy "already in flight" so an old backend's
 * bare `{testId, currentRunId?}` conflicts read exactly as they did before.
 */
export function describeConflict(c: RunConflict): string {
  switch (c.reason) {
    case 'mcp_view_only':
      return 'project is view-only (MCP-mirrored) — not runnable';
    case 'local_address':
      return c.message || 'environment not runnable (local/private/unresolvable URL)';
    case 'not_found':
      return 'not found in this workspace';
    case 'insufficient_credits':
      return c.message || 'insufficient credits';
    case 'paused':
    case 'billing_hold':
      return c.message || 'workspace paused';
    case 'error':
      return c.message || 'dispatch failed';
    case 'in_flight':
    default:
      return c.currentRunId ? `already in flight (run ${c.currentRunId})` : 'already in flight';
  }
}

const CONFLICT_LABELS: Record<ConflictReason, string> = {
  in_flight: 'already in flight',
  mcp_view_only: 'view-only (MCP) project',
  local_address: 'environment not runnable',
  not_found: 'not found',
  insufficient_credits: 'insufficient credits',
  paused: 'workspace paused',
  billing_hold: 'workspace paused',
  error: 'dispatch error',
};

/**
 * True when the set is non-empty and every entry is the legacy in-flight
 * cause (absent reason ⇒ `in_flight` too). Callers use this to restore the
 * original, pre-reason-aware "N test(s) already in flight" wording for the
 * common pure case, while any OTHER reason present (paused,
 * mcp_view_only, …) still falls through to `summarizeConflicts`'s
 * reason-aware summary instead of a misleading blanket "in flight".
 */
export function allConflictsInFlight(conflicts: readonly RunConflict[]): boolean {
  return conflicts.length > 0 && conflicts.every(c => (c.reason ?? 'in_flight') === 'in_flight');
}

/** Per-reason occurrence counts, insertion-ordered; absent reason ⇒ `in_flight`. */
function countByReason(conflicts: readonly RunConflict[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of conflicts) {
    const reason: string = c.reason ?? 'in_flight';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return counts;
}

/**
 * One-line summary of a conflict set grouped by reason, e.g.
 * `2 already in flight, 1 environment not runnable`. Used where a single line
 * must stand in for the whole `conflicts[]` (exit-message / advisory).
 */
export function summarizeConflicts(conflicts: readonly RunConflict[]): string {
  // A future/unknown reason the loose wire schema admits (describeConflict covers
  // it via its default arm) must not render as "N undefined" here.
  return [...countByReason(conflicts).entries()]
    .map(([reason, n]) => `${n} ${CONFLICT_LABELS[reason as ConflictReason] ?? 'not dispatched'}`)
    .join(', ');
}

/**
 * The most frequent conflict reason in a batch (ties → the one seen first), as
 * the raw wire string so a reason this CLI version does not know yet still
 * surfaces. Undefined for an empty set. Feeds the telemetry `conflictReason`
 * field, which allowlists the value before it is sent.
 */
export function dominantConflictReason(conflicts: readonly RunConflict[]): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [reason, n] of countByReason(conflicts)) {
    if (n > bestCount) {
      best = reason;
      bestCount = n;
    }
  }
  return best;
}

/**
 * True when the set is non-empty and EVERY entry carries `reason`. Absent
 * reasons never match (they are `in_flight` by the legacy rule above), so an old
 * backend can never be read as "all insufficient credits".
 */
export function everyConflictIs(
  conflicts: readonly RunConflict[],
  reason: ConflictReason,
): boolean {
  return conflicts.length > 0 && conflicts.every(c => c.reason === reason);
}

/**
 * True for the one batch shape that is really a credits refusal: nothing was
 * dispatched, nothing is rate-deferred (that is exit 7 first), and every
 * conflict says `insufficient_credits`. A newer backend answers this case with
 * a plain 402 envelope itself; this covers a backend that still folds it into
 * `conflicts[]`, so both wire shapes land on the same exit 12.
 */
export function isAllCreditsRefusal(resp: {
  accepted: readonly unknown[];
  deferred: readonly unknown[];
  conflicts: readonly RunConflict[];
}): boolean {
  return (
    resp.accepted.length === 0 &&
    resp.deferred.length === 0 &&
    everyConflictIs(resp.conflicts, 'insufficient_credits')
  );
}

export function isPausedRefusal(resp: {
  accepted: readonly unknown[];
  deferred: readonly unknown[];
  conflicts: readonly RunConflict[];
}): boolean {
  // Paused takes precedence over credits: topping up cannot resume the workspace.
  return (
    resp.accepted.length === 0 &&
    resp.deferred.length === 0 &&
    resp.conflicts.some(c => isPausedReason(c.reason)) &&
    resp.conflicts.every(c => isPausedReason(c.reason) || c.reason === 'insufficient_credits')
  );
}

/**
 * The exit-13 refusal for a batch refused because the workspace is paused —
 * the same `FEATURE_GATED` envelope the backend answers a single run with. The server's message on the conflicts says why
 * the workspace is paused; the fallback deliberately doesn't guess.
 */
export function pausedConflictError(conflicts: readonly RunConflict[], apiUrl?: string): ApiError {
  const message = conflicts.find(c => isPausedReason(c.reason) && c.message?.trim())?.message;
  return ApiError.fromEnvelope(
    {
      error: {
        code: 'FEATURE_GATED',
        message: message ?? 'This workspace is paused.',
        nextAction: '',
        requestId: 'local',
        details: { reason: 'paused', conflicts: conflicts.map(c => c.testId) },
      },
    },
    403,
    undefined,
    apiUrl,
  );
}

export function billingConflictLink(conflicts: readonly RunConflict[], apiUrl?: string): string {
  const hasPaused = conflicts.some(c => isPausedReason(c.reason));
  const hasCredits = conflicts.some(c => c.reason === 'insufficient_credits');
  if (!hasPaused && !hasCredits) return '';
  const refusal = classifyBillingRefusal(
    hasPaused
      ? pausedConflictError(conflicts, apiUrl)
      : insufficientCreditsConflictError(conflicts, apiUrl),
  );
  return refusal ? ` Upgrade: ${refusal.links.pricing}; billing: ${refusal.links.billing}.` : '';
}

/**
 * The exit-12 refusal for an all-credits batch — the SAME `INSUFFICIENT_CREDITS`
 * envelope the single-run route answers (code, exit code, billing `nextAction`),
 * so `index.ts` renders it identically and automation sees one shape. The
 * server's own message (carried on the conflicts) is preferred over the local
 * wording; `apiUrl` resolves the environment-correct portal link.
 */
export function insufficientCreditsConflictError(
  conflicts: readonly RunConflict[],
  apiUrl?: string,
): ApiError {
  const serverMessage = conflicts
    .map(c => c.message?.trim())
    .find((m): m is string => m !== undefined && m !== '');
  const n = conflicts.length;
  return ApiError.fromEnvelope(
    {
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message:
          serverMessage ??
          `Insufficient credits — nothing was queued (${n} test${n !== 1 ? 's' : ''} refused).`,
        nextAction: insufficientCreditsNextAction(apiUrl),
        requestId: 'local',
        details: { reason: 'insufficient_credits', conflicts: conflicts.map(c => c.testId) },
      },
    },
    402,
    undefined,
    apiUrl,
  );
}
