// sys_tool_codingagent.js
// Entity tool that executes code via Claude Code HTTP service

import logger from '../../../../lib/logger.js';
import { resolveFileParameter } from '../../../../lib/fileUtils.js';

const CLAUDE_CODE_URL = process.env.CLAUDE_CODE_URL || 'http://localhost:8080';

export default {
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 100000,
    model: 'oai-gpt41',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        enabled: true,
        icon: "🤖",
        handoff: true,
        function: {
            name: "CodeExecution",
            description: "Execute code autonomously using Claude Code. Use for tasks requiring code execution, data analysis, file generation, web scraping, calculations, or any programming task. Returns results directly - simple answers come back instantly, file outputs include download links.",
            parameters: {
                type: "object",
                properties: {
                    codingTask: {
                        type: "string",
                        description: "Complete task description. Be specific about what you want. The coding agent can write and execute code, install packages, access the internet, create files, and perform calculations. Include all context needed."
                    },
                    inputFiles: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of input files (hash or filename from Available Files). The agent will download these before starting."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to show the user while the task runs"
                    }
                },
                required: ["codingTask", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, resolver}) => {
        try {
            const { codingTask, userMessage, inputFiles, contextId } = args;

            if (!contextId) {
                throw new Error("contextId is required");
            }

            // Build task content with input file URLs
            let taskContent = codingTask;
            
            if (inputFiles?.length > 0) {
                if (!args.agentContext?.length) {
                    throw new Error("agentContext required when using inputFiles");
                }

                const resolvedUrls = [];
                const failedFiles = [];

                for (const fileRef of inputFiles) {
                    const url = await resolveFileParameter(String(fileRef).trim(), args.agentContext);
                    if (url) {
                        resolvedUrls.push(url);
                    } else {
                        failedFiles.push(fileRef);
                    }
                }

                if (failedFiles.length > 0) {
                    throw new Error(`Files not found: ${failedFiles.join(', ')}`);
                }

                if (resolvedUrls.length > 0) {
                    taskContent += `\n\nDownload and use these input files:\n${resolvedUrls.join('\n')}`;
                }
            }

            // Generate unique task ID
            const taskId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            logger.info(`Executing claude-code task: ${taskId}`);

            // Call Claude Code service synchronously
            let response;
            try {
                // Set UI message only after we start the request (so it doesn't show if service is down)
                resolver.tool = JSON.stringify({
                    toolUsed: "coding",
                    codeRequestId: taskId,
                    toolCallbackName: "coding",
                    toolCallbackMessage: userMessage
                });

                response = await fetch(`${CLAUDE_CODE_URL}/execute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        task: taskContent,
                        contextId,
                        taskId
                    })
                });
            } catch (fetchError) {
                // Connection failed - service not running or unreachable
                const isConnectionRefused = fetchError.cause?.code === 'ECONNREFUSED' || 
                                           fetchError.message?.includes('ECONNREFUSED') ||
                                           fetchError.message?.includes('fetch failed');
                if (isConnectionRefused) {
                    throw new Error(`Claude Code service not reachable at ${CLAUDE_CODE_URL}. Is the service running?`);
                }
                throw new Error(`Failed to connect to Claude Code service: ${fetchError.message}`);
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(`Claude Code service returned error ${response.status}: ${errorText || response.statusText}`);
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(`Code execution failed: ${result.error || 'Unknown error'}`);
            }

            // Format response
            let output = result.result || '';
            
            // Add artifacts if any
            if (result.artifacts?.length > 0) {
                output += '\n\n**Files Created:**\n';
                for (const artifact of result.artifacts) {
                    output += `- [${artifact.filename}](${artifact.url})\n`;
                }
            }

            logger.info(`Task ${taskId} completed in ${result.duration_ms}ms`);

            return output;

        } catch (error) {
            logger.error(`CodeExecution error: ${error.stack || error.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "coding", error: true });
            
            // Return clear error for the calling agent
            return `**Code Execution Failed**\n\nError: ${error.message}\n\nPlease inform the user of this error. If this is a service connectivity issue, the coding service may need to be started.`;
        }
    }
};
