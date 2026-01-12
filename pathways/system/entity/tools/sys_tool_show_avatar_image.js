// sys_tool_show_avatar_image.js
// Tool pathway that allows agents to show avatar images/videos to the user in a special UI location
import logger from '../../../../lib/logger.js';
import { loadFileCollection, findFileInCollection } from '../../../../lib/fileUtils.js';
import { sendAvatarImage } from '../../../../lib/pathwayTools.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: { 
        type: "function",
        icon: "🖼️",
        hideExecution: true,
        function: {
            name: "ShowAvatarImage",
            description: "Display avatar images or videos to the user in a special place in the UI. This tool takes one or more image or video files from your file collection and displays them in the avatar area of the interface. The files will be displayed in order, and you can control how long each one is shown. Use this when you want to show the user avatar images or videos in the dedicated avatar display area.",
            parameters: {
                type: "object",
                properties: {
                    files: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Array of image or video files to display (from ListFileCollection or SearchFileCollection): each can be the hash, the filename, the URL, or the GCS URL. Files will be displayed in the order provided. You can find available files in the availableFiles section."
                    },
                    duration: {
                        type: "integer",
                        description: "Optional: Duration in milliseconds to display each image/video before moving to the next one. If not provided, the client will use a default duration. For videos, this controls how long to show each video (videos will play for their full length or this duration, whichever is shorter)."
                    },
                    description: {
                        type: "string",
                        description: "Optional: A description of the avatar images or videos (e.g., 'My current avatar', 'Updated profile picture', 'Avatar animation sequence')"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["files", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const { files, duration, description } = args;

        if (!files || !Array.isArray(files) || files.length === 0) {
            return JSON.stringify({
                error: true,
                message: "Files parameter is required and must be a non-empty array"
            });
        }

        if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
            return JSON.stringify({
                error: true,
                message: "agentContext is required. Use ListFileCollection or SearchFileCollection to find available files."
            });
        }

        try {
            // Load the file collection from all agentContext contexts
            const collection = await loadFileCollection(args.agentContext);
            
            const foundFiles = [];
            const errors = [];

            // Process each file
            for (const fileRef of files) {
                // Find the file in the collection
                const foundFile = findFileInCollection(fileRef, collection);
                
                if (!foundFile) {
                    errors.push(`File not found: "${fileRef}"`);
                    continue;
                }

                // Check if it's an image or video by MIME type
                const mimeType = foundFile.mimeType || foundFile.contentType || '';
                const isImage = mimeType.startsWith('image/') || 
                              /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(foundFile.filename || '');
                const isVideo = mimeType.startsWith('video/') || 
                              /\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i.test(foundFile.filename || '');

                if (!isImage && !isVideo) {
                    errors.push(`File "${foundFile.filename || fileRef}" is not an image or video file (MIME type: ${mimeType || 'unknown'})`);
                    continue;
                }

                foundFiles.push({
                    url: foundFile.url,
                    gcs: foundFile.gcs || null,
                    hash: foundFile.hash || null,
                    filename: foundFile.filename || null
                });
            }

            if (foundFiles.length === 0) {
                return JSON.stringify({
                    error: true,
                    message: `No valid image or video files found. ${errors.join('; ')}`
                });
            }

            // Get the rootRequestId for sending the message (must be rootRequestId, not just requestId)
            const requestId = pathwayResolver.rootRequestId;
            
            if (!requestId) {
                return JSON.stringify({
                    error: true,
                    message: "Unable to determine root request ID for sending avatar image"
                });
            }

            // Send the avatar images/videos to the client
            await sendAvatarImage(requestId, foundFiles, {
                duration: duration || null,
                description: description || null
            });

            pathwayResolver.tool = JSON.stringify({ toolUsed: "ShowAvatarImage" });

            const fileCount = foundFiles.length;
            const fileList = foundFiles.map(f => f.filename || 'file').join(', ');
            const errorText = errors.length > 0 ? ` (${errors.length} file(s) had errors: ${errors.join('; ')})` : '';

            return JSON.stringify({
                success: true,
                message: `${fileCount} avatar file(s) (${fileList}) have been sent for display.${errorText}`,
                fileCount: fileCount,
                errors: errors.length > 0 ? errors : undefined
            });
        } catch (e) {
            logger.error(`Error in ShowAvatarImage tool: ${e.message || e}`);
            return JSON.stringify({
                error: true,
                message: e.message || String(e)
            });
        }
    }
};
