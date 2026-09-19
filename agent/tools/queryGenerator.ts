import { RELATIONSHIPS, TABLE_NAMES, schemaSummary } from "#lib/schema.js";
import { validateQuery } from "#lib/sqlGuard.js";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Step 1 of the pipeline. The model drafts SQL from the user's request and
 * submits it here; this layer pins it to the real schema and hands back a
 * normalized draft plus the next required step.
 */
export default defineTool({
  description: [
    "STEP 1 of the database pipeline. Turn a natural-language request into a SQL draft.",
    "Call this first, before any other database tool, for every request that touches data.",
    "Pass the user's intent and the SQL you drafted for it.",
    "Only the tables and columns in the schema may be used:",
    schemaSummary(),
    `Join path: ${RELATIONSHIPS.join("; ")}.`,
    "Reads must be SELECT. Writes (INSERT/UPDATE) are only for explicit user requests to change data.",
    "DELETE, DROP, TRUNCATE, ALTER, CREATE and GRANT are never permitted.",
    "This tool returns a draft, not results: send the draft to queryValidator next.",
  ].join("\n"),
  inputSchema: z.object({
    intent: z
      .string()
      .min(1)
      .describe("What the user asked for, in plain language."),
    query: z
      .string()
      .min(1)
      .describe("The SQL you drafted for that intent, as a single statement without a trailing semicolon."),
    operation: z
      .enum(["read", "write"])
      .default("read")
      .describe("'read' for a SELECT. 'write' only when the user explicitly asked to add or change data."),
  }),
  label: {
    start: ({ intent }) => `Draft query: ${intent}`,
  },
  execute: async ({ intent, query, operation }) => {
    const result = validateQuery(query);

    if (result.kind === "write" && operation === "read") {
      result.errors.push(
        "The draft modifies data but was submitted as a read. Re-draft as a SELECT, " +
          "or set operation to 'write' only if the user explicitly asked to change data.",
      );
    }
    if (result.kind === "read" && operation === "write") {
      result.warnings.push("Declared as a write but the draft only reads; treating it as a read.");
    }

    const ready = result.errors.length === 0;

    return {
      intent,
      draftQuery: result.normalizedQuery,
      operation: result.kind,
      ready,
      tables: result.tables,
      problems: result.errors,
      notes: result.warnings,
      schema: ready ? undefined : schemaSummary(),
      allowedTables: ready ? undefined : TABLE_NAMES,
      nextStep: ready
        ? "Pass draftQuery to queryValidator unchanged."
        : "Fix the listed problems and call queryGenerator again. Do not call queryValidator with a draft that is not ready.",
    };
  },
});
