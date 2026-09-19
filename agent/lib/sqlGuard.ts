/**
 * Static SQL analysis shared by every database tool.
 *
 * The guard is the only thing standing between model-generated text and the
 * database, so it runs inside the executors too — not just in the validator
 * tool. Ordering the tools correctly is a model behavior; rejecting a bad query
 * is not allowed to depend on it.
 */

import { ALL_COLUMNS, TABLE_NAMES, columnsOf, schemaSummary } from "#lib/schema.js";

export type QueryKind = "read" | "write" | "destructive" | "unknown";

export type Verdict = "allow" | "reject";

export interface ValidationResult {
  verdict: Verdict;
  kind: QueryKind;
  /** True when the statement only reads (SELECT / WITH ... SELECT). */
  readOnly: boolean;
  /** Blocking problems. Non-empty means verdict === "reject". */
  errors: string[];
  /** Non-blocking observations worth surfacing to the user. */
  warnings: string[];
  /** Schema tables the statement references. */
  tables: string[];
  /** The normalized query, safe to execute when verdict === "allow". */
  normalizedQuery: string;
  /** Set when the guard believes the query is an attack rather than a mistake. */
  malicious: boolean;
}

const READ_STARTERS = new Set(["select", "with", "explain", "table", "values"]);
const WRITE_STARTERS = new Set(["insert", "update"]);
const DESTRUCTIVE_STARTERS = new Set([
  "delete",
  "drop",
  "truncate",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "vacuum",
  "reindex",
  "cluster",
  "comment",
  "set",
  "reset",
  "call",
  "do",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "listen",
  "notify",
  "lock",
  "prepare",
  "execute",
  "deallocate",
  "discard",
  "refresh",
  "import",
  "security",
  "merge",
  "replace",
]);

/**
 * Identifiers that must never appear, regardless of statement kind: catalog
 * access, filesystem/network reach-out, privilege changes, and time-based
 * injection probes.
 */
const BANNED_IDENTIFIERS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_shadow",
  "pg_authid",
  "pg_user",
  "pg_roles",
  "pg_database",
  "pg_class",
  "pg_tables",
  "pg_namespace",
  "pg_proc",
  "pg_settings",
  "pg_stat_activity",
  "pg_sleep",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_write_file",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_logical_emit_message",
  "lo_import",
  "lo_export",
  "dblink",
  "dblink_exec",
  "postgres_fdw",
  "copy",
  "dbms_pipe",
  "xp_cmdshell",
  "current_setting",
  "set_config",
  "session_user",
  "pg_sleep_for",
  "pg_sleep_until",
]);

/** Functions the generator is allowed to call. Anything else is rejected. */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "array_agg", "string_agg", "stddev", "variance",
  // numeric
  "abs", "round", "ceil", "ceiling", "floor", "trunc", "mod", "power", "sqrt", "greatest", "least",
  // string
  "lower", "upper", "initcap", "length", "char_length", "trim", "btrim", "ltrim", "rtrim",
  "substring", "substr", "left", "right", "concat", "concat_ws", "replace", "split_part",
  "position", "strpos", "starts_with", "format",
  // date/time
  "now", "current_date", "current_timestamp", "date_trunc", "date_part", "extract", "age",
  "to_char", "to_date", "to_timestamp", "make_date", "make_interval",
  // conditional / cast
  "coalesce", "nullif", "cast", "nvl",
  // window
  "row_number", "rank", "dense_rank", "ntile", "lag", "lead", "first_value", "last_value",
  "percent_rank", "cume_dist",
  // misc
  "distinct", "over", "filter", "interval", "percentile_cont", "percentile_disc", "generate_series",
]);

/**
 * SQL keywords. Identifiers that land in this set are skipped by the
 * table/column allowlist pass.
 */
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset", "join", "inner",
  "left", "right", "full", "outer", "cross", "lateral", "on", "using", "as", "and", "or", "not",
  "in", "is", "null", "like", "ilike", "similar", "between", "case", "when", "then", "else", "end",
  "asc", "desc", "distinct", "all", "any", "some", "exists", "union", "intersect", "except",
  "with", "recursive", "insert", "into", "values", "update", "set", "returning", "true", "false",
  "over", "partition", "rows", "range", "preceding", "following", "current", "row", "unbounded",
  "filter", "within", "nulls", "first", "last", "interval", "cast", "at", "time", "zone", "fetch",
  "next", "only", "explain", "analyze", "verbose", "public", "default", "conflict", "do", "nothing",
  "year", "month", "day", "hour", "minute", "second", "quarter", "week", "epoch", "dow", "doy",
  "text", "integer", "int", "bigint", "numeric", "decimal", "date", "timestamp", "uuid", "boolean",
  "varchar", "char", "float", "real", "double", "precision", "array", "table", "and_", "escape",
]);

interface Scan {
  sanitized: string;
  errors: string[];
  malicious: boolean;
}

/**
 * Replace string literals with placeholders and reject comments / dollar
 * quoting outright. Comments and stacked statements are the classic injection
 * carriers, so they are treated as hostile rather than sloppy.
 */
function scanLiterals(sql: string): Scan {
  const errors: string[] = [];
  let malicious = false;
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ? "; // placeholder: must not tokenize as an identifier
      continue;
    }

    if (ch === '"') {
      const close = sql.indexOf('"', i + 1);
      if (close === -1) {
        errors.push("Unterminated quoted identifier.");
        break;
      }
      out += sql.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      errors.push("SQL comments (--) are not allowed.");
      malicious = true;
      break;
    }

    if (ch === "/" && next === "*") {
      errors.push("SQL block comments (/* */) are not allowed.");
      malicious = true;
      break;
    }

    if (ch === "$" && next === "$") {
      errors.push("Dollar-quoted strings are not allowed.");
      malicious = true;
      break;
    }

    if (ch === "\\") {
      errors.push("Backslash escapes are not allowed.");
      malicious = true;
      break;
    }

    out += ch;
    i += 1;
  }

  return { sanitized: out, errors, malicious };
}

function tokenize(sanitized: string): string[] {
  return sanitized.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|::|<>|>=|<=|!=|\|\||[^\s]/g) ?? [];
}

function isIdentifier(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

export function validateQuery(rawQuery: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tables = new Set<string>();
  let malicious = false;

  const trimmed = rawQuery.trim().replace(/;+\s*$/, "").trim();

  const result = (kind: QueryKind): ValidationResult => ({
    verdict: errors.length > 0 ? "reject" : "allow",
    kind,
    readOnly: kind === "read",
    errors,
    warnings,
    tables: [...tables],
    normalizedQuery: trimmed,
    malicious,
  });

  if (trimmed.length === 0) {
    errors.push("The query is empty.");
    return result("unknown");
  }

  const scan = scanLiterals(trimmed);
  errors.push(...scan.errors);
  malicious ||= scan.malicious;
  if (errors.length > 0) return result("unknown");

  const tokens = tokenize(scan.sanitized);
  const lower = tokens.map((t) => t.toLowerCase());

  // Stacked statements: any semicolon survives only if it is trailing, and we
  // already stripped trailing ones.
  if (lower.includes(";")) {
    errors.push("Multiple statements in one query are not allowed.");
    malicious = true;
    return result("unknown");
  }

  // Statement kind, from the first meaningful keyword.
  const head = lower[0] ?? "";
  let kind: QueryKind = "unknown";
  if (READ_STARTERS.has(head)) kind = "read";
  else if (WRITE_STARTERS.has(head)) kind = "write";
  else if (DESTRUCTIVE_STARTERS.has(head)) kind = "destructive";

  if (kind === "destructive") {
    errors.push(
      `"${head.toUpperCase()}" is a destructive or privileged statement and is permanently blocked. ` +
        "Only SELECT, INSERT and UPDATE are supported.",
    );
    return result(kind);
  }

  if (kind === "unknown") {
    errors.push(`Unrecognized statement starting with "${tokens[0]}".`);
    return result(kind);
  }

  // A read statement must not smuggle a write into a CTE or subquery.
  if (kind === "read") {
    for (const word of ["insert", "update", "delete", "drop", "truncate", "alter", "create", "grant"]) {
      if (lower.includes(word)) {
        errors.push(`A read query must not contain "${word.toUpperCase()}".`);
        malicious = true;
      }
    }
  }

  // Writes must never carry a deletion or schema change either.
  if (kind === "write") {
    for (const word of ["delete", "drop", "truncate", "alter", "create", "grant", "revoke"]) {
      if (lower.includes(word)) {
        errors.push(`"${word.toUpperCase()}" is not allowed inside a write query.`);
        malicious = true;
      }
    }
  }

  // Banned catalog / filesystem / network identifiers.
  for (const token of lower) {
    if (BANNED_IDENTIFIERS.has(token)) {
      errors.push(`"${token}" accesses system internals and is blocked.`);
      malicious = true;
    }
  }

  // Classic injection tautologies, e.g. OR 1=1.
  for (let i = 0; i + 3 < lower.length; i++) {
    if (
      (lower[i] === "or" || lower[i] === "and") &&
      /^\d+$/.test(lower[i + 1]) &&
      lower[i + 2] === "=" &&
      lower[i + 1] === lower[i + 3]
    ) {
      errors.push(`Tautology "${lower[i].toUpperCase()} ${lower[i + 1]}=${lower[i + 3]}" detected.`);
      malicious = true;
    }
  }

  // Collect CTE names so they can be referenced like tables.
  const cteNames = new Set<string>();
  if (head === "with") {
    for (let i = 0; i < lower.length - 1; i++) {
      if (lower[i + 1] === "as" && isIdentifier(tokens[i]) && !SQL_KEYWORDS.has(lower[i])) {
        // `x AS (` at the top of a WITH list.
        if (lower[i + 2] === "(") cteNames.add(lower[i]);
      }
    }
  }

  const knownRelations = new Set([...TABLE_NAMES, ...cteNames]);

  // Table references and aliases.
  const aliases = new Map<string, string>();
  const RELATION_INTRODUCERS = new Set(["from", "join", "into", "update"]);

  for (let i = 0; i < lower.length; i++) {
    if (!RELATION_INTRODUCERS.has(lower[i])) continue;
    let j = i + 1;
    if (lower[j] === "only") j += 1;
    if (lower[j] === "(") continue; // subquery or VALUES list

    let relation = tokens[j];
    if (!relation || !isIdentifier(relation)) continue;
    if (lower[j] === "public" && lower[j + 1] === ".") {
      j += 2;
      relation = tokens[j];
      if (!relation || !isIdentifier(relation)) continue;
    }

    const relationName = relation.toLowerCase();
    if (!knownRelations.has(relationName)) {
      errors.push(
        `Table "${relation}" is not in the schema. Allowed tables: ${TABLE_NAMES.join(", ")}.`,
      );
      continue;
    }
    if (TABLE_NAMES.includes(relationName)) tables.add(relationName);

    // Optional alias: `tbl alias` or `tbl AS alias`.
    let k = j + 1;
    if (lower[k] === "as") k += 1;
    const candidate = tokens[k];
    if (candidate && isIdentifier(candidate) && !SQL_KEYWORDS.has(lower[k])) {
      aliases.set(lower[k], relationName);
    }
  }

  if (tables.size === 0 && cteNames.size === 0 && head !== "values") {
    errors.push("The query does not reference any table from the schema.");
  }

  // Output aliases (`... AS total`) are legal identifiers downstream.
  const outputAliases = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    if (lower[i] === "as" && isIdentifier(tokens[i + 1])) outputAliases.add(lower[i + 1]);
  }

  const allowedColumns = new Set<string>(
    tables.size > 0 ? [...tables].flatMap((t) => columnsOf(t)) : [...ALL_COLUMNS],
  );

  // Identifier allowlist pass: every bare identifier must resolve to a
  // function, keyword, table, alias, or schema column.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isIdentifier(token)) continue;
    const name = lower[i];

    if (lower[i + 1] === "(") {
      // `INSERT INTO customers (...)` is a column list, not a call.
      if (RELATION_INTRODUCERS.has(lower[i - 1] ?? "") && knownRelations.has(name)) continue;
      if (!ALLOWED_FUNCTIONS.has(name) && !SQL_KEYWORDS.has(name)) {
        errors.push(`Function "${token}" is not on the allowlist.`);
        malicious ||= BANNED_IDENTIFIERS.has(name);
      }
      continue;
    }

    if (SQL_KEYWORDS.has(name)) continue;
    if (lower[i - 1] === ".") continue; // handled with its qualifier below
    if (lower[i - 1] === "as") continue; // output alias declaration

    if (lower[i + 1] === ".") {
      const qualified = lower[i + 2];
      if (!knownRelations.has(name) && !aliases.has(name) && name !== "public") {
        errors.push(`Unknown table or alias "${token}".`);
      } else if (qualified && qualified !== "*") {
        const owner = aliases.get(name) ?? name;
        const ownerColumns = columnsOf(owner);
        if (ownerColumns.length > 0 && !ownerColumns.includes(qualified)) {
          errors.push(
            `Column "${qualified}" does not exist on "${owner}". Available: ${ownerColumns.join(", ")}.`,
          );
        }
      }
      continue;
    }

    if (knownRelations.has(name) || aliases.has(name) || outputAliases.has(name)) continue;
    if (allowedColumns.has(name)) continue;

    errors.push(
      `Unknown identifier "${token}". Only schema columns may be used: ${[...allowedColumns].join(", ")}.`,
    );
  }

  // Mass-mutation guards.
  if (head === "update" && !lower.includes("where")) {
    errors.push("UPDATE without a WHERE clause would rewrite the whole table. Add a WHERE clause.");
  }
  if (head === "update") {
    warnings.push("This statement modifies existing rows and requires explicit user approval.");
  }
  if (head === "insert") {
    warnings.push("This statement inserts new rows and requires explicit user approval.");
  }
  if (kind === "read" && !lower.includes("limit") && !lower.includes("count")) {
    warnings.push("No LIMIT clause; the executor will cap the returned rows.");
  }

  return result(kind);
}

/** Human-readable validation report for tool output. */
export function explain(result: ValidationResult): string {
  const lines = [
    `verdict: ${result.verdict}`,
    `statement kind: ${result.kind}`,
    `tables: ${result.tables.join(", ") || "none"}`,
  ];
  if (result.malicious) lines.push("flagged: MALICIOUS — rejected outright, do not retry this query");
  if (result.errors.length > 0) lines.push(`errors:\n- ${result.errors.join("\n- ")}`);
  if (result.warnings.length > 0) lines.push(`warnings:\n- ${result.warnings.join("\n- ")}`);
  if (result.verdict === "reject") lines.push(`schema:\n${schemaSummary()}`);
  return lines.join("\n");
}
