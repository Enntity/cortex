// sys_tool_delegate_web.js
// Delegation tool that invokes the WebAgent subagent for web research tasks
// Part of the subagent delegation architecture to reduce main agent tool complexity

import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSystemEntity } from './shared/sys_entity_tools.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 300, // 5 minutes for research tasks
    
    toolDefinition: {
        type: "function",
        icon: "🔍",
        enabled: false,
        function: {
            name: "WebResearch",
            description: `Delegate web research to a specialized agent that can search the internet, fetch web pages, and search X/Twitter. Use this for any task requiring:
- Internet searches for current information
- Fetching and analyzing web page content
- X/Twitter searches for real-time discussions or social sentiment

The research agent will execute multiple searches in parallel as needed and return synthesized findings with source URLs. This is more efficient than calling individual search tools because the agent can plan and execute a comprehensive research strategy.

Examples of when to use:
- "Find recent news about [topic]"
- "Research [company/person/event]"  
- "What are people saying about [topic] on social media"
- "Get current information about [topic]"`,
            parameters: {
                type: "object",
                properties: {
                    researchTask: {
                        type: "string",
                        description: "Detailed description of what to research. Be specific about what information is needed, any time constraints (e.g., 'from the last week'), and what aspects are most important. The research agent only sees this message, so include all relevant context."
                    },
                    userMessage: {
                        type: "string",
                        description: "A brief, user-friendly message to display while research is in progress (e.g., 'Researching recent AI developments...')"
                    }
                },
                required: ["researchTask", "userMessage"]
            }
        }
    },

    executePathway: async ({args, resolver}) => {
        const { researchTask, userMessage } = args;
        
        if (!researchTask) {
            throw new Error('researchTask is required');
        }

        logger.info(`WebResearch delegation starting: ${researchTask.substring(0, 100)}...`);

        try {
            // Look up WebAgent entity by name (UUID is generated at runtime)
            const webAgent = await getSystemEntity('WebAgent');
            if (!webAgent || !webAgent.id) {
                throw new Error('WebAgent system entity not found - ensure server has been restarted after adding WebAgent to config');
            }
            
            const webAgentEntityId = webAgent.id;
            logger.info(`WebResearch using WebAgent entity: ${webAgentEntityId}`);

            // Call sys_entity_agent with the WebAgent entity
            // Pass only the research task - clean slate for focused research
            const result = await callPathway('sys_entity_agent', {
                entityId: webAgentEntityId,
                chatHistory: [{ 
                    role: "user", 
                    content: researchTask 
                }],
                stream: false,           // Need complete result for tool response
                useMemory: false,        // Ephemeral worker - no continuity memory
                researchMode: false       // Enable thorough research behavior in the subagent
            }, resolver);

            logger.info(`WebResearch delegation completed`);
            
            // Set tool metadata for tracking
            resolver.tool = JSON.stringify({ 
                toolUsed: "WebResearch",
                delegatedTo: "WebAgent",
                entityId: webAgentEntityId
            });

            // Return the research results
            // The result from sys_entity_agent is the synthesized response from WebAgent
            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`WebResearch delegation failed: ${errorMessage}`);
            
            // Return error in a format the main agent can understand and adapt to
            resolver.tool = JSON.stringify({ 
                toolUsed: "WebResearch",
                error: true
            });
            
            return JSON.stringify({
                error: true,
                message: `Web research failed: ${errorMessage}`,
                recoveryHint: "You may try breaking down the research into smaller, more specific queries, or use individual search tools directly if available."
            });
        }
    }
};
