<div align="center">

# 🧵 Zera

**An AI agent built with [eve](https://eve.dev) — tool calling, a layered validation pipeline, and human-in-the-loop approval on anything that writes.**

### An AI data analyst for a textile business — that can't drop your tables.

*Ask in plain English. The agent drafts SQL, a deterministic guard validates it, Postgres runs it read-only — and the moment it wants to change your data, the run pauses and waits for you to say yes.*

<br/>

[![eve](https://img.shields.io/badge/built_with-eve-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://eve.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Gemini](https://img.shields.io/badge/Gemini_3.5-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](https://ai.google.dev/)
</div>


## 💡 Where this came from

This project follows the shape of a talk by **Andrew Qu** (Chief of Software, Vercel) at the **AI Engineer World's Fair**, on how Vercel built a data science agent for their internal teams — and on eve, the framework that came out of it.

[![Watch the talk](https://img.shields.io/badge/▶_Watch_the_talk-How_we_Solved_Agent_Building-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=9dYcwOkpCE8)

> "At Vercel I've built a successful AI data scientist, that has taken the load off of our data team from answering ad-hoc data queries, and fields over 1,200 unique queries a day from just internal Vercelians. I've been building and iterating on it since last september, and it's gone through over 6 different rewrites, the newest one of which has inspired us to build a new agent framework […]"
>
> — Andrew Qu, *How we Solved Agent Building*

The arc he describes is the interesting part: **just prompting → bespoke tooling → embedding Claude Code → filesystem agents → skills-based agents → an agent harness framework.** This project sits at that last step: it's built on [eve](https://eve.dev), Vercel's filesystem-first agent framework.

**Zera is a miniature of that idea.** Same problem — non-technical people asking a database questions in English — solved with the same posture: don't let the model talk to the database directly. Put layers in front of it.

> [!NOTE]
> This is an independent learning project, not affiliated with or endorsed by Vercel. It borrows the architecture, not the codebase.

---

## 🎯 What it does

Ask in plain English. Watch every layer do its job. Here is a **real session** — `eve v0.58.1`, unedited apart from trimming the tool argument previews.

### 📊 A read: question → SQL → rows → report

```console
│ do we have any customers from LA ? if yes then have then done any buisness with us
│ ? if yes what have they bought and whats the total amount of that product sales in LA ?

  ▪ queryGenerator    intent="Find total amount of each produ…"  query="SELECT c.name A…"
   → draftQuery="SELECT c.name AS customer…"  ready=true
  ▪ queryValidator    query="SELECT c.name AS customer_name,…"  source="generated"
   → verdict="allow"  malicious=false  operation="read"
  ▪ queryDatabase     query="SELECT c.name AS customer_name,…"
   → status="ok"  rowCount=4
  ▪ outputFormatter   title="Products and Total Quantities S…"  rows=[4]
   → formatted="### Products and Total Quantiti…"

▲ Products and Total Quantities Sold to Los Angeles Customers

  Yes, we have a customer in Los Angeles (Karen Scott) who has made multiple
  purchases, totaling several thousand units across cotton poplin, flannel pillow
  covers, french terry fleece, and linen blend fabric.

  ┌───────────────┬─────────────┬─────────────────────────────────┬──────────────┐
  │ Customer Name │ City        │ Product                         │ Total Amount │
  ├───────────────┼─────────────┼─────────────────────────────────┼──────────────┤
  │ Karen Scott   │ Los Angeles │ Cotton Poplin Shirting (meters) │        8,672 │
  │ Karen Scott   │ Los Angeles │ Linen Blend Fabric (meters)     │        2,468 │
  │ Karen Scott   │ Los Angeles │ French Terry Fleece (meters)    │        1,717 │
  │ Karen Scott   │ Los Angeles │ Flannel Pillow Covers (pieces)  │          958 │
  └───────────────┴─────────────┴─────────────────────────────────┴──────────────┘
```

One vague question, four tools, in order. Notice the agent never touched the database directly — `queryGenerator` drafted, `queryValidator` cleared it, and only then did `queryDatabase` run it.

### 🔐 A write: the run stops and waits for a human

Same session, follow-up message:

```console
│ can you update the Flannel Pillow Covers purshase of karen scott from 958 to 334

  ▪ queryGenerator       intent="Update the amount of Flannel Pi…"  query="UPDATE sales SE…"
   → draftQuery="UPDATE sales SET amount =…"
  ▪ queryValidator       query="UPDATE sales SET amount = 334 W…"  source="generated"
   → verdict="allow"  malicious=false  operation="write"      ← flagged as a write
  ? customQueryExecutor  query="UPDATE sales SET amount = 334 W…"  reason="Update Kar…"
                         ⏸  run parked — waiting for your decision
  ▪ outputFormatter      title="Update Sale Amount"  rows=[0]  insight="Updated Karen Scot…"

▲ Update Sale Amount

  Updated Karen Scott's Flannel Pillow Covers purchase quantity from 958 to 334.

  ✅ Applied. 1 row was changed after your approval.
```

The `?` marker is the whole point: the validator classified the statement as `operation="write"`, so it was routed to the **privileged** executor, which **suspended the run** rather than executing. Nothing changed until a human approved it.

> [!TIP]
> The pause is durable, not a blocking `await`. eve parks the turn at `session.waiting` and the process can restart while it waits — seconds or days — then resume exactly where it left off.

---

## 🏗️ Architecture

Every request walks the same five-step pipeline. No step is skippable — the executors **verify** that a query cleared the validator and refuse it otherwise.

```mermaid
flowchart LR
    U([👤 User]) --> AG

    subgraph AGENT [" "]
        direction LR
        AG[🧵 Zera<br/><i>gemini-3.5-flash-lite</i>]
    end

    AG --> G["1️⃣ queryGenerator<br/><sub>intent → SQL draft</sub>"]
    G --> V{"2️⃣ queryValidator<br/><sub>the safety gate</sub>"}

    V -->|"☠️ malicious"| X["⛔ Refuse<br/><sub>do not re-draft</sub>"]
    V -->|"❌ invalid"| G
    V -->|"✅ read"| D["3️⃣ queryDatabase<br/><sub>READ ONLY txn</sub>"]
    V -->|"✍️ write"| C["3️⃣ customQueryExecutor<br/><sub>privileged</sub>"]

    C -.->|"pauses the run"| H{{"🙋 Human approval"}}
    H -->|approve| C
    H -->|deny| X

    D --> F["4️⃣ outputFormatter<br/><sub>rows → report</sub>"]
    C --> F
    F --> U

    style V fill:#f59e0b,stroke:#b45309,color:#fff
    style H fill:#3b82f6,stroke:#1d4ed8,color:#fff
    style X fill:#ef4444,stroke:#b91c1c,color:#fff
    style D fill:#10b981,stroke:#047857,color:#fff
    style C fill:#8b5cf6,stroke:#6d28d9,color:#fff
```

### The five tools

| # | Tool | Role |
|:-:|:-----|:-----|
| 1️⃣ | **`queryGenerator`** | Turns intent into a SQL draft and pins it to the real schema. Catches a write submitted as a read. |
| 2️⃣ | **`queryValidator`** | The gate. Runs the guard, records the pass, and separates *malicious* from merely *wrong*. |
| 3️⃣ | **`queryDatabase`** | Reads only. Runs inside a `READ ONLY` transaction with a timeout and a row cap. |
| 3️⃣ | **`customQueryExecutor`** | 🔐 Writes and user-supplied SQL. **Pauses the run for human approval.** |
| 4️⃣ | **`outputFormatter`** | Rows → markdown report: aligned numerics, totals, shortened UUIDs. |

---

## 🛡️ The safety model

The interesting design decision: **tool ordering is a convention, not the security boundary.**

The SQL guard (`agent/lib/sqlGuard.ts`) re-runs *inside* both executors. If the model skips the validator, or calls an executor directly, the query is still analyzed from scratch. Ordering makes the agent well-behaved; the guard makes it safe.

| | Category | Rejected |
|:-:|:---|:---|
| 🗑️ | **Destructive statements** | `DELETE` · `DROP` · `TRUNCATE` · `ALTER` · `CREATE` · `GRANT` · `REVOKE` · `COPY` · `VACUUM` |
| 💉 | **Injection carriers** | Stacked statements (`;`) · `--` and `/* */` comments · dollar quoting · backslash escapes · `OR 1=1` tautologies |
| 🔑 | **System & host access** | `pg_catalog` · `information_schema` · `pg_sleep` · `pg_read_file` · `dblink` · any function outside the allowlist |
| 📋 | **Schema violations** | Tables or columns not in the schema · stale column names · unknown identifiers |
| 💥 | **Mass mutation** | `UPDATE` with no `WHERE` · writes hidden inside a read CTE |

**Defence in depth, in layers:**

| Layer | Guarantee |
|:------|:----------|
| 🧠 Instructions | The model is *told* the rules and the pipeline order. |
| 🔍 Static guard | The query is *parsed* and checked against the schema. |
| 📒 Session ledger | Executors confirm the query actually cleared the validator. |
| 🙋 Approval policy | Unsafe queries are auto-denied and **never shown to a human**. Only real decisions reach you. |
| 🔒 Postgres | Reads run in `SET TRANSACTION READ ONLY` — a guard miss still cannot write. |
| ⏱️ Limits | 15s statement timeout · 500 row cap · writes roll back on error. |

---

## 🙋 Human in the loop

Writes are not something the agent is trusted to decide alone. `customQueryExecutor` is the **only** path to an `INSERT` or `UPDATE`, and it is gated on a real person.

### How it's wired

eve supports this natively: a tool declares an `approval` policy, and returning `"user-approval"` **durably suspends the run** until someone answers. Rather than a blanket `always()`, Zera uses an input-dependent policy:

```ts
// agent/tools/customQueryExecutor.ts
approval: ({ session, toolInput }) => {
  const result = validateQuery(toolInput?.query);

  // Unsafe or unvalidated queries are denied outright — the human never sees them.
  if (result.verdict === "reject") {
    return { type: "denied", reason: result.malicious
      ? `Blocked as unsafe: ${result.errors.join(" ")}`
      : `Failed validation: ${result.errors.join(" ")}` };
  }
  if (!wasValidated(session.id, result.normalizedQuery)) {
    return { type: "denied", reason: "This query has not been through queryValidator." };
  }

  return "user-approval";   // ⏸ park the run and ask a person
},
```

### Why deny *before* prompting

An approval dialog you click through a hundred times is worse than no approval at all. Every automated check runs **first**, so anything unsafe is rejected without ever reaching you.

> [!IMPORTANT]
> By the time a prompt appears, the query is already known to be safe, schema-valid and validator-approved. What's left is the only question a machine can't answer: *do you actually want this data changed?*

### What's gated

| Tool | Approval | Why |
|:--|:-:|:--|
| `queryGenerator` | ❌ | Produces text, touches nothing. |
| `queryValidator` | ❌ | Read-only analysis. |
| `queryDatabase` | ❌ | `READ ONLY` transaction — cannot write by construction. |
| **`customQueryExecutor`** | ✅ **every call** | The only path to a write, and the route for user-supplied SQL. |

And because the guard re-runs **after** approval, an approved-then-replayed step can't slip past validation — approval settles *intent*, the guard settles *safety*.

---

## 🗄️ The data

A textile manufacturer selling yarn, fabric, home textiles and finished garments to US customers.

```mermaid
erDiagram
    CUSTOMERS ||--o{ SALES : places
    SALESPERSON ||--o{ SALES : books

    CUSTOMERS {
        uuid id PK
        text name
        text city
        text industry "Denim, Knitwear, Home Textiles…"
    }
    SALESPERSON {
        uuid id PK
        text name
        text city
        int year_of_joining
    }
    SALES {
        uuid id PK
        uuid customer_id FK
        uuid salesperson_id FK "nullable"
        text product "unit noted in the name"
        int amount "QUANTITY, not money"
        date sale_date
    }
```

> [!WARNING]
> **`amount` is a quantity, not currency.** It counts units shipped — pieces, kilograms or meters — with the unit carried in the product name (`Combed Cotton Yarn 30s (kg)`). The agent is instructed never to render it as money, and the formatter refuses to put a `$` on it.

`salesperson_id` is nullable — roughly 8% of seeded sales are unattributed, so `LEFT JOIN` behaviour actually gets exercised.

---

## 🚀 Quickstart

**Prerequisites:** Node 24.x · pnpm · a Postgres database (Supabase works) · a Google AI API key.

```bash
# 1 — install
pnpm install

# 2 — configure
cat > .env <<'EOF'
SUPABASE_URL=postgresql://user:pass@host:5432/postgres
GOOGLE_GENERATIVE_AI_API_KEY=your-key
EOF

# 3 — seed 120 textile sales, 28 customers, 12 salespeople
node --env-file=.env scripts/seed.mjs

# 4 — run
pnpm dev
```

`pnpm dev` opens an interactive TUI. Try these:

| Prompt | Exercises |
|:-------|:----------|
| `top 5 customers by units shipped` | read path, join, aggregate |
| `which rep closed the most volume in 2025?` | three-table join |
| `how many sales have no salesperson attached?` | nullable FK |
| `move Betty Walker to Austin` | 🔐 **approval prompt** |
| `drop the sales table` | ⛔ refusal |

### 🌱 Seeding

`scripts/seed.mjs` is **insert-only and deterministic** — a fixed PRNG seed reproduces the same rows, existing records are folded into the pool so they gain history, and it skips itself if the table is already populated.

```bash
node --env-file=.env scripts/seed.mjs           # seed once
node --env-file=.env scripts/seed.mjs --force   # add another batch
```

---

## 📁 Project structure

```
agent/
├── instructions.md              # 🧠 identity, the pipeline order, domain rules
├── agent.ts                     # model + runtime config
├── lib/
│   ├── schema.ts                # 📋 the allowlist — single source of truth
│   ├── sqlGuard.ts              # 🛡️ static SQL analysis (the real boundary)
│   ├── validationLedger.ts      # 📒 per-session record of validated queries
│   └── db.ts                    # pg pool
└── tools/
    ├── queryGenerator.ts        # 1️⃣ intent  → SQL
    ├── queryValidator.ts        # 2️⃣ SQL     → verdict
    ├── queryDatabase.ts         # 3️⃣ SQL     → rows      (read-only)
    ├── customQueryExecutor.ts   # 3️⃣ SQL     → rows      (🔐 approval)
    └── outputFormatter.ts       # 4️⃣ rows    → report

scripts/seed.mjs                 # 🌱 deterministic mock data
```

**Widening what the agent may touch is a one-line change** in `agent/lib/schema.ts`. Every layer reads from it.

---

## 🧭 Design notes

**Why a guard instead of a prompt.** An instruction is a suggestion to a model. A parser is not. The guard is ~480 lines of boring string analysis, covered by a 40-case battery of legitimate queries and attacks, and it runs whether or not the model cooperates.

**Why deny before prompting.** An approval dialog you click through a hundred times is worse than no approval at all. Auto-denying anything unsafe means every prompt that reaches a human is a genuine business decision.

**Why the model still drafts the SQL.** The model is good at intent → SQL and bad at self-restraint. So it drafts; deterministic code decides.

**Where it's deliberately strict.** Unknown identifiers are rejected rather than passed through, so a hallucinated column fails fast with the schema attached instead of producing a confusing Postgres error.

---

## 📚 Learn more

- 📘 [eve documentation](https://eve.dev/docs) — the agent framework this is built on
- 🎓 [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent)
- 🔐 [Human-in-the-loop](https://eve.dev/docs/tools/human-in-the-loop) — the approval model used here
- 🧰 [eve on GitHub](https://github.com/vercel/eve)
- 🛠️ [skills.sh](https://skills.sh) — Andrew Qu's agent skills registry

<div align="center">
<br/>
<sub>Built with <a href="https://eve.dev">eve</a> · inspired by a talk about agents that people actually use</sub>
</div>
