/**
 * Seeds the textile sales database with mock data.
 *
 * Additive and deterministic: it only INSERTs, never deletes, and a fixed PRNG
 * seed means a given run always produces the same rows. Existing customers and
 * salespeople are folded into the pool so their records gain history too.
 *
 *   node --env-file=.env scripts/seed.mjs [--force]
 */

import pg from "pg";

const FORCE = process.argv.includes("--force");
const TARGET_SALES = 120;

// --- deterministic PRNG (mulberry32) ------------------------------------

let state = 0x5ea1ed;
function rand() {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + Math.floor(rand() * (max - min + 1));

// --- reference data -----------------------------------------------------

const FIRST_NAMES = [
  "James", "Mary", "Robert", "Patricia", "Michael", "Jennifer", "David", "Linda",
  "William", "Elizabeth", "Richard", "Barbara", "Joseph", "Susan", "Thomas", "Jessica",
  "Charles", "Sarah", "Daniel", "Karen", "Matthew", "Nancy", "Anthony", "Lisa",
  "Mark", "Betty", "Donald", "Margaret", "Steven", "Sandra", "Andrew", "Ashley",
  "Kenneth", "Emily", "Joshua", "Donna", "Kevin", "Michelle", "Brian", "Carol",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
];

// Real US cities, weighted toward actual textile and apparel hubs.
const CITIES = [
  "Charlotte", "Greensboro", "Raleigh", "Gastonia", "Atlanta", "Dalton",
  "Greenville", "Spartanburg", "Columbia", "Nashville", "Memphis", "Birmingham",
  "Dallas", "Houston", "El Paso", "Los Angeles", "San Francisco", "Fresno",
  "New York", "Brooklyn", "Philadelphia", "Boston", "Providence", "Fall River",
  "Chicago", "Cleveland", "Detroit", "Indianapolis", "Minneapolis", "Kansas City",
  "Denver", "Phoenix", "Portland", "Seattle", "Miami", "Orlando", "Savannah",
];

const INDUSTRIES = [
  "Cotton", "Denim", "Knitwear", "Home Textiles", "Activewear", "Apparel",
  "Upholstery", "Technical Textiles", "Wool", "Linen", "Outerwear", "Workwear",
  "Tech Wear", "Clothing",
];

// The unit is carried in the product name, because `amount` is a bare integer.
const PRODUCTS = [
  { name: "Combed Cotton Yarn 30s (kg)", min: 400, max: 6000 },
  { name: "Carded Cotton Yarn 20s (kg)", min: 400, max: 6000 },
  { name: "Organic Cotton Blend Yarn (kg)", min: 250, max: 4000 },
  { name: "Recycled Polyester Yarn (kg)", min: 300, max: 5000 },
  { name: "Merino Wool Yarn (kg)", min: 100, max: 1500 },
  { name: "Denim Twill 12oz (meters)", min: 800, max: 18000 },
  { name: "Stretch Denim 10oz (meters)", min: 600, max: 14000 },
  { name: "Cotton Poplin Shirting (meters)", min: 1000, max: 20000 },
  { name: "Linen Blend Fabric (meters)", min: 500, max: 9000 },
  { name: "Single Jersey Knit (meters)", min: 900, max: 16000 },
  { name: "French Terry Fleece (meters)", min: 700, max: 12000 },
  { name: "Ripstop Canvas (meters)", min: 400, max: 8000 },
  { name: "Upholstery Jacquard (meters)", min: 300, max: 6000 },
  { name: "Performance Mesh Knit (meters)", min: 500, max: 10000 },
  { name: "Cotton Bath Towels (pieces)", min: 200, max: 5000 },
  { name: "Percale Bed Sheet Sets (pieces)", min: 150, max: 3000 },
  { name: "Flannel Pillow Covers (pieces)", min: 200, max: 4000 },
  { name: "Crew Neck T-Shirts (pieces)", min: 500, max: 12000 },
  { name: "Fleece Hoodies (pieces)", min: 200, max: 6000 },
  { name: "Selvedge Denim Jeans (pieces)", min: 100, max: 2500 },
  { name: "Canvas Work Jackets (pieces)", min: 80, max: 1800 },
  { name: "Compression Leggings (pieces)", min: 300, max: 7000 },
];

const uniqueName = (used) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  throw new Error("Could not generate a unique name.");
};

function randomDate(startMs, endMs) {
  return new Date(startMs + rand() * (endMs - startMs)).toISOString().slice(0, 10);
}

// --- seeding ------------------------------------------------------------

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_URL });

async function main() {
  const existing = await pool.query("SELECT count(*)::int AS n FROM public.sales");
  if (existing.rows[0].n >= TARGET_SALES && !FORCE) {
    console.log(`sales already has ${existing.rows[0].n} rows; nothing to do (use --force to add more).`);
    return;
  }

  const usedNames = new Set();
  const priorCustomers = await pool.query("SELECT name FROM public.customers");
  const priorSalespeople = await pool.query("SELECT name FROM public.salesperson");
  for (const r of [...priorCustomers.rows, ...priorSalespeople.rows]) usedNames.add(r.name);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- salespeople ---
    const salespeople = Array.from({ length: 12 }, () => ({
      name: uniqueName(usedNames),
      city: pick(CITIES),
      year: between(2012, 2025),
    }));
    const spResult = await client.query(
      `INSERT INTO public.salesperson (name, city, year_of_joining)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
       RETURNING id`,
      [salespeople.map((s) => s.name), salespeople.map((s) => s.city), salespeople.map((s) => s.year)],
    );

    // --- customers ---
    const customers = Array.from({ length: 28 }, () => ({
      name: uniqueName(usedNames),
      city: pick(CITIES),
      industry: pick(INDUSTRIES),
    }));
    const custResult = await client.query(
      `INSERT INTO public.customers (name, city, industry)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       RETURNING id`,
      [customers.map((c) => c.name), customers.map((c) => c.city), customers.map((c) => c.industry)],
    );

    // Existing rows join the pool so they gain history too.
    const allCustomerIds = [
      ...custResult.rows.map((r) => r.id),
      ...(await client.query("SELECT id FROM public.customers")).rows.map((r) => r.id),
    ];
    const customerIds = [...new Set(allCustomerIds)];
    const salespersonIds = [
      ...new Set((await client.query("SELECT id FROM public.salesperson")).rows.map((r) => r.id)),
    ];
    void spResult;

    // --- sales ---
    const start = Date.parse("2024-01-01");
    const end = Date.parse("2026-09-19");
    const sales = Array.from({ length: TARGET_SALES }, () => {
      const product = pick(PRODUCTS);
      return {
        customer_id: pick(customerIds),
        product: product.name,
        amount: between(product.min, product.max),
        sale_date: randomDate(start, end),
        // ~8% of sales are unattributed, so LEFT JOIN behavior is exercised.
        salesperson_id: rand() < 0.08 ? null : pick(salespersonIds),
      };
    });

    await client.query(
      `INSERT INTO public.sales (customer_id, product, amount, sale_date, salesperson_id)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::int[], $4::date[], $5::uuid[])`,
      [
        sales.map((s) => s.customer_id),
        sales.map((s) => s.product),
        sales.map((s) => s.amount),
        sales.map((s) => s.sale_date),
        sales.map((s) => s.salesperson_id),
      ],
    );

    await client.query("COMMIT");
    console.log(
      `inserted ${salespeople.length} salespeople, ${customers.length} customers, ${sales.length} sales.`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

await main();
await pool.end();
