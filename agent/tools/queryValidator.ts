import { schemaSummary } from "#lib/schema.js";
import { explain, validateQuery } from "#lib/sqlGuard.js";
import { recordValidation } from "#lib/validationLedger.js";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Step 2 of the pipeline, and the security gate. Nothing reaches the database
 * without clearing this check — the executors re-run the same guard, so a
 * rejection here cannot be routed around by calling them directly.
 */
export default defineTool({
  description: [
    "STEP 2 of the database pipeline, and a mandatory gate. Validate a SQL query before it is executed.",
    "Every query must pass through here: drafts from queryGenerator, and any query the user supplies directly.",
    "Checks performed: single statement only, no comments or dollar quoting, no injection tautologies,",
    "no system-catalog or filesystem access, functions restricted to an allowlist, and every table and",
    "column checked against the schema:",
    schemaSummary(),
    "Reads must be SELECT and non-destructive. INSERT and UPDATE are allowed only when the user explicitly",
    "asked to change data, and they still require the user's approval at execution time.",
    "DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT and any other destructive statement are rejected outright.",
    "If the result is flagged malicious, stop: reject the request to the user and do not re-draft that query.",
    "On verdict 'allow', send the validatedQuery to queryDatabase (reads) or customQueryExecutor (writes).",
  ].join("\n"),
  inputSchema: z.object({
    query: z.string().min(1).describe("The SQL query to validate, exactly as it will be executed."),
    source: z
      .enum(["generated", "user_supplied"])
      .default("generated")
      .describe("'generated' for a queryGenerator draft, 'user_supplied' when the user wrote the SQL."),
  }),
  label: {
    start: ({ query }) => `Validate SQL: ${query.slice(0, 60)}`,
  },
  execute: async ({ query, source }, ctx) => {
    const result = validateQuery(query);

    if (result.verdict === "allow") {
      recordValidation(ctx.session.id, result.normalizedQuery, result);
    }

    const requiresApproval = result.kind === "write";

    return {
      verdict: result.verdict,
      malicious: result.malicious,
      operation: result.kind,
      source,
      validatedQuery: result.verdict === "allow" ? result.normalizedQuery : undefined,
      tables: result.tables,
      errors: result.errors,
      warnings: result.warnings,
      report: explain(result),
      requiresApproval,
      nextStep:
        result.verdict === "reject"
          ? result.malicious
            ? "REJECT the request. Tell the user the query was blocked as unsafe and why. Do not retry it."
            : "Return to queryGenerator, fix the listed errors, and validate again."
          : requiresApproval
            ? "Call customQueryExecutor with validatedQuery. It will pause for the user's approval before running."
            : "Call queryDatabase with validatedQuery.",
    };
  },
});
