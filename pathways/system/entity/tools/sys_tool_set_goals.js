// sys_tool_set_goals.js
// System tool for the expensive model to declare its execution goals.
// Intercepted in processToolCallRound (never actually executed as a pathway).
// Category "system" excludes it from wildcard entity tool lists.

export default {
    prompt: [],
    timeout: 1,
    toolDefinition: {
        type: "function",
        category: "system",
        icon: "📋",
        hideExecution: true,
        toolCost: 0,
        function: {
            name: "SetGoals",
            description: "Declare everything that needs to happen before this request is done. Call this alongside your first tool calls. Not a sequential recipe — a checklist of outcomes.",
            parameters: {
                type: "object",
                properties: {
                    goal: { type: "string", description: "What the user needs — one sentence" },
                    steps: { type: "array", items: { type: "string" }, description: "2-5 specific things to accomplish (not how — what)" }
                },
                required: ["goal", "steps"]
            }
        }
    },
    executePathway: async () => JSON.stringify({ success: true, message: 'Goals acknowledged.' })
};
