/**
 * The single source of truth for what the agent is allowed to touch.
 * Every validation layer reads from here, so widening access is a one-line change.
 */

export type TableName = keyof typeof SCHEMA;

export const SCHEMA = {
  customers: {
    columns: {
      id: "uuid",
      name: "text",
      city: "text",
      industry: "text",
    },
    primaryKey: "id",
  },
  salesperson: {
    columns: {
      id: "uuid",
      name: "text",
      city: "text",
      year_of_joining: "integer",
    },
    primaryKey: "id",
  },
  sales: {
    columns: {
      id: "uuid",
      customer_id: "uuid",
      product: "text",
      amount: "integer",
      sale_date: "date",
      salesperson_id: "uuid",
    },
    primaryKey: "id",
  },
} as const satisfies Record<string, { columns: Record<string, string>; primaryKey: string }>;

export const TABLE_NAMES: string[] = Object.keys(SCHEMA);

export const ALL_COLUMNS: Set<string> = new Set(
  Object.values(SCHEMA).flatMap((table) => Object.keys(table.columns)),
);

export function columnsOf(table: string): string[] {
  const entry = SCHEMA[table as TableName];
  return entry ? Object.keys(entry.columns) : [];
}

/**
 * `sales.amount` is a QUANTITY, not money: pieces, kilograms or meters
 * depending on the product. Never present it as currency.
 */
export const AMOUNT_SEMANTICS =
  "sales.amount is a quantity shipped (pieces, kg or meters — the unit is noted in the product name), not a monetary value.";

/** A compact rendering of the schema for prompts and tool error messages. */
export function schemaSummary(): string {
  return Object.entries(SCHEMA)
    .map(([table, def]) => {
      const cols = Object.entries(def.columns)
        .map(([name, type]) => `${name} ${type}`)
        .join(", ");
      return `${table}(${cols})`;
    })
    .join("\n");
}

/** The only join paths the schema supports. */
export const RELATIONSHIPS = [
  "sales.customer_id = customers.id",
  "sales.salesperson_id = salesperson.id",
] as const;

/**
 * `name` and `city` exist on both customers and salesperson, so an unqualified
 * reference is ambiguous in a join. Queries must qualify them.
 */
export const AMBIGUOUS_COLUMNS = ["name", "city", "id"] as const;
