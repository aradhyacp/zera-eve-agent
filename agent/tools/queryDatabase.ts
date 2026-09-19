import pool from "#lib/db.js";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
    description: "Query the database table for specific records matching a criteria.",
    inputSchema: z.object({
        query: z.string().describe("The SQL query to execute."),
    }),
    execute: async ({ query }) => {
        const result = await pool.query(query);
        return JSON.stringify(result);
    },
});