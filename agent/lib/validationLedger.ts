/**
 * Records which queries cleared the validator in a given session, so the
 * executors can enforce the pipeline order: generate -> validate -> execute.
 *
 * This is a flow check, not the security boundary. The executors re-run
 * `validateQuery` on every call, so a lost ledger entry (process restart) can
 * only cost an extra validator call, never an unchecked execution.
 */

import type { ValidationResult } from "#lib/sqlGuard.js";

interface LedgerEntry {
  kind: ValidationResult["kind"];
  validatedAt: number;
}

const MAX_SESSIONS = 200;
const ledger = new Map<string, Map<string, LedgerEntry>>();

/** Whitespace- and case-insensitive key so trivial reformatting still matches. */
export function fingerprint(query: string): string {
  return query.trim().replace(/;+$/, "").replace(/\s+/g, " ").toLowerCase();
}

export function recordValidation(
  sessionId: string,
  query: string,
  result: ValidationResult,
): void {
  if (result.verdict !== "allow") return;

  let entries = ledger.get(sessionId);
  if (!entries) {
    if (ledger.size >= MAX_SESSIONS) {
      const oldest = ledger.keys().next();
      if (!oldest.done) ledger.delete(oldest.value);
    }
    entries = new Map();
    ledger.set(sessionId, entries);
  }
  entries.set(fingerprint(query), { kind: result.kind, validatedAt: Date.now() });
}

export function wasValidated(sessionId: string, query: string): boolean {
  return ledger.get(sessionId)?.has(fingerprint(query)) ?? false;
}
