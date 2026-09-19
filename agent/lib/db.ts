import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.SUPABASE_URL!,
});

export default pool;