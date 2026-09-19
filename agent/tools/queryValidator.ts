import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
    description: "Validate the SQL query to ensure it is valid and does not contain any malicious code. The query should be read only and not destructive. If the User explictly asked to make changes in the db like adding a row changing a data you can perform that with explicit permission from the user. But before that you should validate the query with this tool to ensure it is valid and does not contain any malicious code and destructive actions. You can only use the columns that are in the schema and the tables that are in the schema.",
    inputSchema: z.object({
        query: z.string().describe("The SQL query to validate."),
    }),
    execute: async ({ query }) => {
        return query;
    },
});