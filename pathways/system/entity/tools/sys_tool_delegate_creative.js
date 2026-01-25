// sys_tool_delegate_creative.js
// Delegation tool that invokes the CreativeAgent subagent for image, video, and slides generation
// Part of the subagent delegation architecture to reduce main agent tool complexity

import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSystemEntity } from './shared/sys_entity_tools.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600, // 10 minutes for video generation which can be slow
    
    toolDefinition: {
        type: "function",
        icon: "🎨",
        enabled: false,
        hideExecution: true,
        function: {
            name: "CreateMedia",
            description: `Delegate creative content generation to a specialized agent with access to these tools:
- GenerateImage: Create new images from scratch (artwork, illustrations, photos, graphics)
- ModifyImage: Edit, transform, or apply effects to existing images (requires referenceFiles)
- CreateAvatarVariant: Create variations of the entity's avatar/selfie images
- SetBaseAvatar: Update the entity's base avatar image
- GenerateVideo: Create short 8-second video clips from text or images
- GenerateSlides: Create presentation slides, infographics, and visual diagrams

The creative agent will select the appropriate tool and create detailed prompts for best results. It returns file references that you can display to the user using markdown.

Examples of when to use:
- "Create an image of [description]" → GenerateImage
- "Edit/modify this image to [changes]" → ModifyImage (pass referenceFiles)
- "Create a selfie/picture of me" → CreateAvatarVariant
- "Generate a video showing [scene]" → GenerateVideo
- "Make a slide/infographic about [topic]" → GenerateSlides
- "Turn this image into a video" → GenerateVideo (pass referenceFiles)`,
            parameters: {
                type: "object",
                properties: {
                    creativeTask: {
                        type: "string",
                        description: "Detailed description of what to create. Be specific about the type of content (image/video/slide), style, composition, colors, mood, and any other relevant visual details. The creative agent only sees this message, so include all relevant context and descriptive information."
                    },
                    referenceFiles: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of file references (hash, filename, or file ID from your Available Files or file collection) to use as input for the creative task. Use this when the user wants to modify, transform, or use existing images/videos as references. Up to 3 files supported."
                    },
                    userMessage: {
                        type: "string",
                        description: "A brief, user-friendly message to display while content is being generated (e.g., 'Creating your landscape image...')"
                    }
                },
                required: ["creativeTask", "userMessage"]
            }
        }
    },

    executePathway: async ({args, resolver}) => {
        const { creativeTask, referenceFiles, userMessage } = args;
        
        if (!creativeTask) {
            throw new Error('creativeTask is required');
        }

        logger.info(`CreateMedia delegation starting: ${creativeTask.substring(0, 100)}...`);

        try {
            // Look up CreativeAgent entity by name (UUID is generated at runtime)
            const creativeAgent = await getSystemEntity('CreativeAgent');
            if (!creativeAgent || !creativeAgent.id) {
                throw new Error('CreativeAgent system entity not found - ensure server has been restarted after adding CreativeAgent to config');
            }
            
            const creativeAgentEntityId = creativeAgent.id;
            logger.info(`CreateMedia using CreativeAgent entity: ${creativeAgentEntityId}`);

            // Build the message content for the creative agent
            // Include file references if provided (subtools handle resolution)
            let messageContent = creativeTask;
            if (referenceFiles && Array.isArray(referenceFiles) && referenceFiles.length > 0) {
                messageContent += `\n\n**Reference Files:**\n${referenceFiles.map((ref, i) => `${i + 1}. ${ref}`).join('\n')}`;
            }

            // Call sys_entity_agent with the CreativeAgent entity
            // Pass contextId and contextKey so the agent can add files to the collection
            const result = await callPathway('sys_entity_agent', {
                entityId: creativeAgentEntityId,
                chatHistory: [{ 
                    role: "user", 
                    content: messageContent 
                }],
                contextId: args.contextId,      // Pass through for file collection
                contextKey: args.contextKey,    // Pass through for file collection
                stream: false,           // Need complete result for tool response
                useMemory: false,        // Ephemeral worker - no continuity memory
                researchMode: false
            }, resolver);

            logger.info(`CreateMedia delegation completed`);
            
            // Set tool metadata for tracking
            resolver.tool = JSON.stringify({ 
                toolUsed: "CreateMedia",
                delegatedTo: "CreativeAgent",
                entityId: creativeAgentEntityId
            });

            // Return the creative results
            // The result from sys_entity_agent is the synthesized response from CreativeAgent
            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`CreateMedia delegation failed: ${errorMessage}`);
            
            // Return error in a format the main agent can understand and adapt to
            resolver.tool = JSON.stringify({ 
                toolUsed: "CreateMedia",
                error: true
            });
            
            return JSON.stringify({
                error: true,
                message: `Creative content generation failed: ${errorMessage}`,
                recoveryHint: "You may try simplifying the request, using a different style, or breaking down the task into smaller parts."
            });
        }
    }
};
