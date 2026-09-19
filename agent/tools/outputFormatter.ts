import { defineTool } from "eve/tools";
import { z } from "zod";

type Row = Record<string, unknown>;

const NUMERIC_COLUMN = /(amount|total|count|sum|avg|revenue|value|qty|quantity|price|year)/i;
// `amount` is a shipped quantity (pieces / kg / meters), never money, so it is
// deliberately absent here. Only genuinely monetary columns get a currency mark.
const CURRENCY_COLUMN = /(revenue|price|cost|usd)/i;
// Years are integers that must not be grouped as 2,024.
const PLAIN_INTEGER_COLUMN = /(year|_id$|^id$)/i;

function formatCell(column: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" || (typeof value === "string" && value !== "" && !Number.isNaN(Number(value)) && NUMERIC_COLUMN.test(column))) {
    const num = Number(value);
    if (PLAIN_INTEGER_COLUMN.test(column)) return String(num);
    const formatted = Number.isInteger(num)
      ? num.toLocaleString("en-US")
      : num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return CURRENCY_COLUMN.test(column) ? `$${formatted}` : formatted;
  }
  if (typeof value === "object") return JSON.stringify(value);

  const text = String(value);
  // UUIDs are noise in a report; keep them identifiable but short.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? `${text.slice(0, 8)}…`
    : text;
}

function humanizeHeader(column: string): string {
  return column
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function markdownTable(columns: string[], rows: Row[]): string {
  const header = `| ${columns.map(humanizeHeader).join(" | ")} |`;
  const divider = `| ${columns.map((c) => (NUMERIC_COLUMN.test(c) ? "---:" : ":---")).join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => formatCell(c, row[c])).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

function totalsLine(columns: string[], rows: Row[]): string | undefined {
  const sums = columns
    // Summing years or IDs is meaningless, so they are excluded.
    .filter((c) => NUMERIC_COLUMN.test(c) && !PLAIN_INTEGER_COLUMN.test(c))
    .map((c) => {
      const values = rows
        .map((row) => Number(row[c]))
        .filter((n) => Number.isFinite(n));
      if (values.length === 0) return undefined;
      const total = values.reduce((a, b) => a + b, 0);
      const suffix = /amount|qty|quantity/i.test(c) ? " units" : "";
      return `**${humanizeHeader(c)} total:** ${formatCell(c, total)}${suffix}`;
    })
    .filter((line): line is string => line !== undefined);

  return sums.length > 0 ? sums.join(" · ") : undefined;
}

/**
 * Final step of the pipeline. Turns raw rows into the answer the user reads.
 */
export default defineTool({
  description: [
    "FINAL STEP of the database pipeline. Format query results into the answer shown to the user.",
    "Call this after queryDatabase or customQueryExecutor, before writing your reply.",
    "Pass the rows exactly as the executor returned them, plus a short title and a one-line insight.",
    "It renders a markdown table, formats dates and IDs, and adds totals for numeric columns.",
    "Note: sales.amount is a quantity (pieces, kg or meters), not money. Never describe it as revenue or dollars.",
    "Reply to the user with the returned 'formatted' text as-is; add context only if the user asked for analysis.",
  ].join("\n"),
  inputSchema: z.object({
    title: z.string().min(1).describe("A short heading for the result, e.g. 'Top customers by revenue'."),
    rows: z
      .array(z.record(z.string(), z.any()))
      .default([])
      .describe("The rows returned by the executor, unchanged."),
    insight: z
      .string()
      .optional()
      .describe("One or two sentences answering the user's question directly."),
    operation: z
      .enum(["read", "write"])
      .default("read")
      .describe("'write' when reporting the outcome of an INSERT or UPDATE."),
    rowsAffected: z
      .number()
      .optional()
      .describe("For a write, how many rows the statement changed."),
    truncated: z
      .boolean()
      .default(false)
      .describe("True when the executor capped the result set."),
    note: z.string().optional().describe("Any caveat the user should see, e.g. an approval or a cap."),
  }),
  label: {
    start: ({ title }) => `Format results: ${title}`,
  },
  execute: async ({ title, rows, insight, operation, rowsAffected, truncated, note }) => {
    const sections: string[] = [`### ${title}`];

    if (insight) sections.push(insight);

    if (operation === "write") {
      const affected = rowsAffected ?? rows.length;
      sections.push(
        `✅ **Applied.** ${affected} row${affected === 1 ? "" : "s"} ${affected === 1 ? "was" : "were"} changed after your approval.`,
      );
    }

    if (rows.length === 0) {
      sections.push(
        operation === "write"
          ? "_No rows were returned by the statement._"
          : "_No rows matched this query._",
      );
    } else {
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

      if (rows.length === 1 && columns.length <= 2) {
        // A single scalar answer reads better as a line than as a table.
        sections.push(
          columns.map((c) => `**${humanizeHeader(c)}:** ${formatCell(c, rows[0][c])}`).join(" · "),
        );
      } else {
        sections.push(markdownTable(columns, rows));
        const totals = totalsLine(columns, rows);
        if (totals && rows.length > 1) sections.push(totals);
        sections.push(`_${rows.length} row${rows.length === 1 ? "" : "s"}${truncated ? " (capped)" : ""}._`);
      }
    }

    if (truncated) sections.push("> Results were capped. Narrow the request or add a LIMIT for a precise set.");
    if (note) sections.push(`> ${note}`);

    return { formatted: sections.join("\n\n") };
  },
});
