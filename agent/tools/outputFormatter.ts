import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
    description: "Format the output of the query to be more readable and human friendly.",
    inputSchema: z.object({
        output: z.string().describe("The output of the query to format."),
    }),
    execute: async ({ output }) => {
        return output;
    },
});