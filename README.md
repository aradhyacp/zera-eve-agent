<div align="center">

# 🧵 Zera

### An AI data analyst for a textile business — that can't drop your tables.

*A small, opinionated take on the "an agent on every desk" idea: natural language in, validated SQL out, with a human standing between the model and anything destructive.*

<br/>

[![eve](https://img.shields.io/badge/built_with-eve-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://eve.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Gemini](https://img.shields.io/badge/Gemini_3.5-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](https://ai.google.dev/)

<br/>

![Node](https://img.shields.io/badge/node-24.x-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Zod](https://img.shields.io/badge/zod-4.5.4-3E67B1?style=flat-square&logo=zod&logoColor=white)
![AI SDK](https://img.shields.io/badge/AI_SDK-7-000000?style=flat-square)
![Guard tests](https://img.shields.io/badge/guard_tests-40%2F40-success?style=flat-square)
![Approval](https://img.shields.io/badge/writes-human_approved-orange?style=flat-square)
![Status](https://img.shields.io/badge/status-learning_project-blue?style=flat-square)

</div>

---

## 💡 Where this came from

This project follows the shape of a talk by **Andrew Qu** (Chief of Software, Vercel) at the **AI Engineer World's Fair**, on how Vercel built a data science agent for their internal teams.

> "At Vercel I've built a successful AI data scientist, that has taken the load off of our data team from answering ad-hoc data queries, and fields over 1,200 unique queries a day from just internal Vercelians. I've been building and iterating on it since last september, and it's gone through over 6 different rewrites, the newest one of which has inspired us to build a new agent framework […]"
>
> — Andrew Qu, *How we Solved Agent Building*

The arc he describes is the interesting part: **just prompting → bespoke tooling → embedding Claude Code → filesystem agents → skills-based agents → an agent harness framework.** This project sits at that last step: it's built on [eve](https://eve.dev), Vercel's filesystem-first agent framework.

**Zera is a miniature of that idea.** Same problem — non-technical people asking a database questions in English — solved with the same posture: don't let the model talk to the database directly. Put layers in front of it.

> [!NOTE]
> This is an independent learning project, not affiliated with or endorsed by Vercel. It borrows the architecture, not the codebase.

---

## 🎯 What it does

Ask in plain English. Get a validated query, real rows, and a formatted answer.

```
You  ▸  who are our biggest customers by volume this year?

Zera ▸  ### Top customers by units shipped

        Mark Harris leads on volume, driven by Tech Wear orders out of El Paso.

        | Customer        | City      | Industry      | Amount |
        | :-------------- | :-------- | :------------ | -----: |
        | Mark Harris     | El Paso   | Tech Wear     | 48,344 |
        | Susan Anderson  | El Paso   | Home Textiles | 36,969 |
        | Betty Allen     | Atlanta   | Knitwear      | 32,814 |

        **Amount total:** 118,127 units
```

And when you ask for something it shouldn't do on its own:

```
You  ▸  delete all sales before 2024

Zera ▸  I can't delete data — DELETE is permanently blocked for me.
        I can show you which rows match, or flag them instead. Want either?
```

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

<table>
<tr><th align="left">⛔ Rejected outright</th><th align="left">🧪 Also caught</th></tr>
<tr valign="top"><td>

`DELETE` · `DROP` · `TRUNCATE`
`ALTER` · `CREATE` · `GRANT`
`REVOKE` · `COPY` · `VACUUM`

</td><td>

Stacked statements (`;`)
`--` and `/* */` comments
Dollar quoting · backslash escapes
`OR 1=1` tautologies

</td></tr>
<tr valign="top"><td>

`pg_catalog` · `information_schema`
`pg_sleep` · `pg_read_file` · `dblink`
Functions outside an allowlist

</td><td>

Tables/columns not in the schema
Writes hidden inside a read CTE
`UPDATE` with no `WHERE`

</td></tr>
</table>

**Defence in depth, in layers:**

| Layer | Guarantee |
|:------|:----------|
| 🧠 Instructions | The model is *told* the rules and the pipeline order. |
| 🔍 Static guard | The query is *parsed* and checked against the schema. |
| 📒 Session ledger | Executors confirm the query actually cleared the validator. |
| 🙋 Approval policy | Unsafe queries are auto-denied and **never shown to a human**. Only real decisions reach you. |
| 🔒 Postgres | Reads run in `SET TRANSACTION READ ONLY` — a guard miss still cannot write. |
| ⏱️ Limits | 15s statement timeout · 500 row cap · writes roll back on error. |

> [!IMPORTANT]
> The approval policy denies before it prompts. You are only ever asked to approve a query that already passed every automated check — which keeps the prompt meaningful instead of something you learn to click through.

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

## ☁️ Deploy

```bash
eve deploy
```

Links a Vercel project if needed and deploys to production. Set `SUPABASE_URL` and `GOOGLE_GENERATIVE_AI_API_KEY` in the project's environment variables. See the [eve deployment docs](https://eve.dev/docs/guides/deployment/vercel).

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
