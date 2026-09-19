import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
    description: "Execute a custom SQL query on the database.",
    inputSchema: z.object({
        query: z.string().describe("The SQL query to execute."),
    }),
    execute: async ({ query }) => {
        return query;
    },
});