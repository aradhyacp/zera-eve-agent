import pool from "#lib/db.js";
import { explain, validateQuery } from "#lib/sqlGuard.js";
import { wasValidated } from "#lib/validationLedger.js";
import { defineTool } from "eve/tools";
import { z } from "zod";

const ROW_CAP = 500;
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * The privileged executor. It is the only path to a write, so it is gated on
 * human approval and on a prior validator pass. The approval policy denies
 * anything the guard rejects outright, so the user is never asked to approve a
 * query that was already unsafe.
 */
export default defineTool({
  description: [
    "PRIVILEGED executor. Requires the user's explicit approval before every run; the turn pauses until they answer.",
    "Use it for exactly two cases:",
    "1. The user explicitly asked to add or change data (INSERT or UPDATE).",
    "2. The user supplied their own SQL to run.",
    "The query must already have passed queryValidator in this session; pass the validatedQuery unchanged.",
    "A user-supplied query may first be optimized for the same result set, but the optimized version must be",
    "re-validated before it is executed here.",
    "Writes run in a transaction and are rolled back if the statement fails.",
    "DELETE and any destructive statement are rejected and never reach approval.",
    "For an ordinary read that you generated, use queryDatabase instead.",
  ].join("\n"),
  inputSchema: z.object({
    query: z.string().min(1).describe("The validated SQL query to execute."),
    reason: z
      .string()
      .min(1)
      .describe("What this query does and why, in one plain sentence. Shown to the user in the approval prompt."),
  }),
  label: {
    start: ({ reason }) => `Privileged query: ${reason}`,
  },

  // Auto-deny anything unsafe or unvalidated; otherwise pause for the user.
  approval: ({ session, toolInput }) => {
    const query = typeof toolInput?.query === "string" ? toolInput.query : undefined;
    if (query === undefined) {
      return { type: "denied", reason: "No query was supplied." };
    }

    const result = validateQuery(query);
    if (result.verdict === "reject") {
      return {
        type: "denied",
        reason: result.malicious
          ? `Blocked as unsafe: ${result.errors.join(" ")}`
          : `Failed validation: ${result.errors.join(" ")}`,
      };
    }
    if (!wasValidated(session.id, result.normalizedQuery)) {
      return {
        type: "denied",
        reason: "This query has not been through queryValidator in this session. Validate it first.",
      };
    }

    return "user-approval";
  },

  execute: async ({ query, reason }, ctx) => {
    // Re-checked after approval: the approval decision is about intent, this is
    // about safety, and a replayed step must not skip it.
    const result = validateQuery(query);

    if (result.verdict === "reject") {
      return {
        status: "refused" as const,
        reason: "The query failed validation.",
        report: explain(result),
      };
    }

    if (!wasValidated(ctx.session.id, result.normalizedQuery)) {
      return {
        status: "refused" as const,
        reason: "This query has not been through queryValidator in this session.",
        nextStep: "Call queryValidator with this exact query, then try again.",
      };
    }

    const sql =
      result.readOnly && !/\blimit\b/i.test(result.normalizedQuery)
        ? `${result.normalizedQuery} LIMIT ${ROW_CAP}`
        : result.normalizedQuery;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (result.readOnly) await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const queryResult = await client.query(sql);
      await client.query("COMMIT");

      const rows = queryResult.rows.slice(0, ROW_CAP);
      return {
        status: "ok" as const,
        approvedReason: reason,
        query: sql,
        operation: result.kind,
        rowsAffected: queryResult.rowCount ?? 0,
        columns: queryResult.fields.map((field) => field.name),
        rows,
        warnings: result.warnings,
        nextStep: "Pass the outcome to outputFormatter, then confirm to the user what changed.",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        status: "error" as const,
        query: sql,
        rolledBack: true,
        reason: error instanceof Error ? error.message : String(error),
        nextStep: "Tell the user nothing was changed, and explain the error.",
      };
    } finally {
      client.release();
    }
  },
});
