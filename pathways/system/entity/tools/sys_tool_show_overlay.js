// sys_tool_show_overlay.js
// Tool pathway that allows agents to show overlay playlist items in a special UI location
import logger from '../../../../lib/logger.js';
import { loadFileCollection, findFileInCollection } from '../../../../lib/fileUtils.js';
import { sendAppCommand } from '../../../../lib/pathwayTools.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: {
        type: "function",
        icon: "🖼️",
        hideExecution: true,
        function: {
            name: "ShowOverlay",
            description: "Display an overlay containing images, videos, or text in a prominent area of the UI. Provide an array of items to show in sequence with an optional duration and label. Use this any time you want to show something special to the user outside of the chat markdown - great for showing selfies, etc. The items will be displayed in the order they are provided in the array.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["text", "image", "video"],
                                    description: "The item type: 'text' for text overlay, 'image' for image, 'video' for video."
                                },
                                content: {
                                    type: "string",
                                    description: "For text items: the text to display in the overlay."
                                },
                                file: {
                                    type: "string",
                                    description: "For image/video items: a file reference from FileCollection (hash, filename, URL, or GCS URL)."
                                },
                                duration: {
                                    type: "number",
                                    description: "Optional: how long to show this item in seconds. If omitted, the client default is used."
                                },
                                label: {
                                    type: "string",
                                    description: "Optional: short label or caption for this item."
                                }
                            },
                            required: ["type"]
                        },
                        description: "Ordered array of overlay items. Each item can be text (with content), image (with file), or video (with file). Optional duration (seconds) and label."
                    }
                },
                required: ["items"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const { items, entityId } = args;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return JSON.stringify({
                error: true,
                message: "items parameter is required and must be a non-empty array"
            });
        }

        if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
            return JSON.stringify({
                error: true,
                message: "agentContext is required. Use FileCollection to find available files."
            });
        }

        try {
            // Load the file collection from all agentContext contexts
            const collection = await loadFileCollection(args.agentContext);
            
            const overlayItems = [];
            const errors = [];

            // Process each item
            for (const [index, item] of items.entries()) {
                if (!item || typeof item !== 'object') {
                    errors.push(`Item ${index + 1} is not an object`);
                    continue;
                }

                const type = item.type;
                const duration = typeof item.duration === 'number' ? item.duration : undefined;
                const label = typeof item.label === 'string' ? item.label : undefined;

                if (type === 'text') {
                    const content = typeof item.content === 'string' ? item.content.trim() : '';
                    if (!content) {
                        errors.push(`Item ${index + 1} (text) is missing content`);
                        continue;
                    }

                    overlayItems.push({
                        type: 'text',
                        content,
                        ...(duration !== undefined && { duration }),
                        ...(label && { label })
                    });
                    continue;
                }

                if (type !== 'image' && type !== 'video') {
                    errors.push(`Item ${index + 1} has invalid type "${type}" (must be text, image, or video)`);
                    continue;
                }

                const fileRef = item.file;
                if (!fileRef || typeof fileRef !== 'string') {
                    errors.push(`Item ${index + 1} (${type}) is missing a file reference`);
                    continue;
                }

                const foundFile = findFileInCollection(fileRef, collection);
                if (!foundFile) {
                    errors.push(`File not found for item ${index + 1}: "${fileRef}"`);
                    continue;
                }

                const mimeType = foundFile.mimeType || foundFile.contentType || '';
                const isImage = mimeType.startsWith('image/') || 
                              /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(foundFile.filename || '');
                const isVideo = mimeType.startsWith('video/') || 
                              /\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i.test(foundFile.filename || '');

                if (type === 'image' && !isImage) {
                    errors.push(`Item ${index + 1} expects an image file, but "${foundFile.filename || fileRef}" is not an image (MIME type: ${mimeType || 'unknown'})`);
                    continue;
                }

                if (type === 'video' && !isVideo) {
                    errors.push(`Item ${index + 1} expects a video file, but "${foundFile.filename || fileRef}" is not a video (MIME type: ${mimeType || 'unknown'})`);
                    continue;
                }

                overlayItems.push({
                    type,
                    url: foundFile.url,
                    ...(foundFile.gcs && { gcs: foundFile.gcs }),
                    ...(foundFile.hash && { hash: foundFile.hash }),
                    ...(foundFile.filename && { filename: foundFile.filename }),
                    ...(duration !== undefined && { duration }),
                    ...(label && { label })
                });
            }

            if (overlayItems.length === 0) {
                return JSON.stringify({
                    error: true,
                    message: `No valid items found. ${errors.join('; ')}`
                });
            }

            // Get the rootRequestId for sending the message (must be rootRequestId, not just requestId)
            const requestId = pathwayResolver.rootRequestId;
            
            if (!requestId) {
                return JSON.stringify({
                    error: true,
                    message: "Unable to determine root request ID for sending overlay command"
                });
            }

            // Send the showOverlay app command
            await sendAppCommand(requestId, {
                type: 'showOverlay',
                items: overlayItems,
                ...(entityId && { entityId })
            });

            pathwayResolver.tool = JSON.stringify({ toolUsed: "ShowOverlay" });

            const itemCount = overlayItems.length;
            const errorText = errors.length > 0 ? ` (${errors.length} item(s) had errors: ${errors.join('; ')})` : '';

            // Keep return minimal - narrative is already sent via SSE command
            // Don't include narrative or items here to avoid model repeating them
            return JSON.stringify({
                success: true,
                message: `Overlay displayed.${errorText}`,
                itemCount: itemCount,
                errors: errors.length > 0 ? errors : undefined
            });
        } catch (e) {
            logger.error(`Error in ShowOverlay tool: ${e.message || e}`);
            return JSON.stringify({
                error: true,
                message: e.message || String(e)
            });
        }
    }
};
