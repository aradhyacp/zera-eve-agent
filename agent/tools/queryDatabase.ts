import pool from "#lib/db.js";
import { explain, validateQuery } from "#lib/sqlGuard.js";
import { wasValidated } from "#lib/validationLedger.js";
import { defineTool } from "eve/tools";
import { z } from "zod";

const ROW_CAP = 500;
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Step 3 of the pipeline, for reads only. The connection is put into a
 * read-only transaction, so even a guard miss cannot write.
 */
export default defineTool({
  description: [
    "STEP 3 of the database pipeline. Execute a read-only SELECT that has already passed queryValidator.",
    "The query must be the exact validatedQuery string returned by queryValidator; anything else is refused.",
    "This tool runs inside a read-only transaction and cannot insert, update or delete.",
    `Results are capped at ${ROW_CAP} rows.`,
    "For INSERT or UPDATE, use customQueryExecutor instead.",
    "After this returns, pass the rows to outputFormatter before answering the user.",
  ].join("\n"),
  inputSchema: z.object({
    query: z.string().min(1).describe("The validated read-only SQL query to execute."),
  }),
  label: {
    start: ({ query }) => `Run query: ${query.slice(0, 60)}`,
  },
  execute: async ({ query }, ctx) => {
    const result = validateQuery(query);

    if (result.verdict === "reject") {
      return {
        status: "refused" as const,
        reason: "The query failed validation.",
        report: explain(result),
        nextStep: "Fix the query with queryGenerator and re-validate before trying again.",
      };
    }

    if (!result.readOnly) {
      return {
        status: "refused" as const,
        reason: `This tool only runs read-only queries; the statement is a ${result.kind}.`,
        nextStep: "Use customQueryExecutor for writes. It requires the user's approval.",
      };
    }

    if (!wasValidated(ctx.session.id, result.normalizedQuery)) {
      return {
        status: "refused" as const,
        reason: "This query has not been through queryValidator in this session.",
        nextStep: "Call queryValidator with this exact query first, then call queryDatabase again.",
      };
    }

    const sql = /\blimit\b/i.test(result.normalizedQuery)
      ? result.normalizedQuery
      : `${result.normalizedQuery} LIMIT ${ROW_CAP}`;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const queryResult = await client.query(sql);
      await client.query("COMMIT");

      const rows = queryResult.rows.slice(0, ROW_CAP);
      return {
        status: "ok" as const,
        query: sql,
        rowCount: rows.length,
        truncated: queryResult.rows.length > ROW_CAP,
        columns: queryResult.fields.map((field) => field.name),
        rows,
        warnings: result.warnings,
        nextStep: "Pass these rows to outputFormatter, then answer the user.",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        status: "error" as const,
        query: sql,
        reason: error instanceof Error ? error.message : String(error),
        nextStep: "Report the database error to the user, or correct the query with queryGenerator.",
      };
    } finally {
      client.release();
    }
  },
});
