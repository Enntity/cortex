// sys_tool_image.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, resolveFileParameter, buildFileCreationResponse, loadFileCollection, findFileInCollection, getSignedFileUrl } from '../../../../lib/fileUtils.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
    },
    timeout: 300,
    toolDefinition: [{
        type: "function",
        icon: "🖼️",
        function: {
            name: "SetBaseAvatar",
            description: "Use when you wish to update or replace your base avatar image - the main avatar image that represents your visual identity. Proceed with caution as this can permanently change how you look to the user.",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "An image file from your available files (from Available Files section or workspace) to set as your new base avatar. The file can be referenced by filename, blob path, or URL."
                    },
                    userMessage: {
                        type: "string",
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ["file", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const chatId = args.chatId || null;

        try {   
            let model = "replicate-seedream-4";
            let prompt = args.detailedInstructions || "";

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            
            // Get base avatar image from entity record (for CreateAvatarImage and CreateAvatarVariant)
            let resolvedBaseAvatarImage = null;
            let entityIdForAvatar = null;
            let needsBaseAvatarSet = false;
            const toolFunctionLower = (args.toolFunction || '').toLowerCase();
            const isAvatar = toolFunctionLower === "createavatarimage" || toolFunctionLower === "createavatarvariant";
            if (isAvatar) {
                // Get entityId from args (set by the entity runtime executor)
                entityIdForAvatar = args.entityId;
                if (!entityIdForAvatar) {
                    throw new Error("entityId is required for CreateAvatarImage tool. This should be automatically provided by the system.");
                }
                
                // Load entity config to get base avatar
                const entityConfig = await loadEntityConfig(entityIdForAvatar);
                if (!entityConfig) {
                    throw new Error(`Entity not found: ${entityIdForAvatar}`);
                }
                
                // Use qwen-image-edit-2511 for all avatar generation (better quality image editing)
                model = "replicate-qwen-image-edit-2511";
                
                // Get base avatar image from entity record
                const baseAvatar = entityConfig.avatar?.image;
                if (baseAvatar && baseAvatar.url) {
                    let avatarUrl = baseAvatar.url;
                    const signedUrl = await getSignedFileUrl(
                        baseAvatar.blobPath || avatarUrl,
                    );
                    if (signedUrl) avatarUrl = signedUrl;
                    resolvedBaseAvatarImage = avatarUrl;
                } else {
                    // No base avatar exists - will generate from scratch
                    needsBaseAvatarSet = true;
                }
            }
            // If we have input images (non-avatar), use the qwen-image-edit-2511 model
            else if (args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0) {
                model = "replicate-qwen-image-edit-2511";
            }
            
            // Resolve all input images to URLs using the common utility
            // Fail early if any provided image cannot be resolved
            const resolvedInputImages = [];
            if (args.inputImages && Array.isArray(args.inputImages)) {
                if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                    throw new Error("agentContext is required when using the 'inputImages' parameter. Check your available files or browse /workspace/files/.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, args.agentContext);
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Check your available files or browse /workspace/files/.`);
                    }
                    resolvedInputImages.push(resolved);
                }
            }
            
            // Build parameters object, only including image parameters if they have non-empty values
            const params = {
                ...args, 
                text: prompt, 
                model, 
                stream: false,
            };
            
            // Configure avatar generation settings - qwen-image-edit-2511 config
            if (isAvatar) {
                params.aspectRatio = "1:1"; // Square aspect ratio for avatars
                params.output_format = "webp"; // WebP for smaller file size
                params.output_quality = 80; // Good quality
                params.go_fast = true; // Run faster predictions with optimizations
                params.disable_safety_checker = true;
                
                // If editing existing avatar, pass reference image as array (qwen expects image array)
                if (resolvedBaseAvatarImage) {
                    params.input_image = resolvedBaseAvatarImage;
                }
            }
            
            if (resolvedInputImages.length > 0) {
                params.input_image = resolvedInputImages[0];
            }
            if (resolvedInputImages.length > 1) {
                params.input_image_2 = resolvedInputImages[1];
            }
            if (resolvedInputImages.length > 2) {
                params.input_image_3 = resolvedInputImages[2];
            }

            // Set default aspectRatio for qwen-image-edit-2511 model
            if (model === "replicate-qwen-image-edit-2511") {
                params.aspectRatio = "match_input_image";
            }
            
            // Call appropriate pathway based on model
            let pathwayName;
            if (model.includes('flux')) {
                pathwayName = 'image_flux';
            } else if (model.includes('seedream')) {
                pathwayName = 'image_seedream4';
            } else {
                pathwayName = 'image_qwen';
            }
            let result = await callPathway(pathwayName, params, pathwayResolver);

            // Process artifacts from Replicate (which come as URLs, not base64 data)
            if (pathwayResolver.pathwayResultData) {
                if (pathwayResolver.pathwayResultData.artifacts && Array.isArray(pathwayResolver.pathwayResultData.artifacts)) {
                    const uploadedImages = [];
                    
                    // Process each image artifact
                    for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
                        if (artifact.type === 'image' && artifact.url) {
                            try {
                                // Replicate artifacts have URLs, not base64 data
                                // Download the image and upload it to cloud storage
                                const imageUrl = artifact.url;
                                const mimeType = artifact.mimeType || 'image/png';
                                
                                // Upload image to cloud storage and return the stored file URL.
                                const uploadResult = await uploadFileToCloud(
                                    imageUrl,
                                    mimeType,
                                    null, // filename will be generated
                                    pathwayResolver,
                                    args.contextId,
                                    args.chatId || null
                                );
                                
                                const uploadedUrl = uploadResult.url || uploadResult;

                                const imageData = {
                                    type: 'image',
                                    url: uploadedUrl,
                                    mimeType: mimeType,
                                    filename: uploadResult.filename || null,
                                    blobPath: uploadResult.blobPath || null,
                                };

                                uploadedImages.push(imageData);
                            } catch (uploadError) {
                                pathwayResolver.logError(`Failed to upload image from Replicate: ${uploadError.message}`);
                                // Keep original URL as fallback
                                uploadedImages.push({
                                    type: 'image',
                                    url: artifact.url,
                                    mimeType: artifact.mimeType || 'image/png'
                                });
                            }
                        } else {
                            // Keep non-image artifacts as-is
                            uploadedImages.push(artifact);
                        }
                    }
                    
                    // Return the URLs of the uploaded images in structured format
                    // Replace the result with uploaded cloud URLs (not the original Replicate URLs)
                    if (uploadedImages.length > 0) {
                        const successfulImages = uploadedImages.filter(img => img.url);
                        if (successfulImages.length > 0) {
                            // Build imageUrls array in the format expected by pathwayTools.js for toolImages injection
                            // This format matches ViewImages tool so images get properly injected into chat history
                                const imageUrls = successfulImages.map((img) => {
                                    return {
                                        type: "image_url",
                                        url: img.url,
                                        image_url: { url: img.url },
                                        blobPath: img.blobPath || null,
                                        filename: img.filename || null,
                                    };
                                });
                            
                            const isModification = args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0;
                            const isAvatar = args.toolFunction === "createavatarimage" || args.toolFunction === "CreateAvatarImage";
                            const action = isModification ? 'Image modification' : (isAvatar ? 'Avatar generation' : 'Image generation');
                            
                            // If this is CreateAvatarImage and no base avatar existed, automatically set the first generated image as base avatar
                            if (isAvatar && needsBaseAvatarSet && successfulImages.length > 0) {
                                try {
                                    const firstImage = successfulImages[0];
                                    const entityConfig = await loadEntityConfig(entityIdForAvatar);
                                    if (entityConfig) {
                                        const avatarImage = {
                                            url: firstImage.url,
                                            name: null,
                                            blobPath: firstImage.blobPath || null,
                                            contextId: args.contextId || null
                                        };
                                        
                                        // Update entity with new base avatar
                                        const entityStore = getEntityStore();
                                        const updatedEntity = {
                                            ...entityConfig,
                                            avatar: {
                                                ...(entityConfig.avatar || {}),
                                                image: avatarImage
                                            }
                                        };
                                        
                                        await entityStore.upsertEntity(updatedEntity);
                                    }
                                } catch (avatarSetError) {
                                    // Log but don't fail - base avatar setting is a convenience feature
                                    pathwayResolver.logWarning(`Failed to automatically set base avatar: ${avatarSetError.message}`);
                                }
                            }
                            
                            result = buildFileCreationResponse(successfulImages, {
                                mediaType: 'image',
                                action: action,
                                imageUrls
                            });
                        }
                    }
                }
            }

            // Handle SetBaseAvatar tool call
            if (args.toolFunction === "setbaseavatar" || args.toolFunction === "SetBaseAvatar") {
                // Get entityId from args (set by the entity runtime executor)
                const entityId = args.entityId;
                if (!entityId) {
                    throw new Error("entityId is required for SetBaseAvatar tool. This should be automatically provided by the system.");
                }
                
                // Validate required parameters
                if (!args.file) {
                    throw new Error("file parameter is required for SetBaseAvatar tool.");
                }
                
                // agentContext should be provided by the entity runtime executor via args
                // It's passed from the parent pathway, not from the LLM tool call
                if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                    throw new Error("agentContext is required for SetBaseAvatar tool. This should be automatically provided by the system. If you see this error, it may indicate a system configuration issue.");
                }
                const agentContext = args.agentContext;
                
                // Load current entity config
                const entityConfig = await loadEntityConfig(entityId);
                if (!entityConfig) {
                    throw new Error(`Entity not found: ${entityId}`);
                }
                
                // Resolve the file reference
                const collection = await loadFileCollection(agentContext);
                const foundFile = findFileInCollection(args.file, collection);
                
                if (!foundFile) {
                    throw new Error(`File not found: "${args.file}". Check your available files or browse /workspace/files/.`);
                }
                
                // Validate it's an image
                const mimeType = foundFile.mimeType || foundFile.contentType || '';
                const isImage = mimeType.startsWith('image/') || 
                              /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(foundFile.filename || '');
                
                if (!isImage) {
                    throw new Error(`File "${foundFile.filename || args.file}" is not an image file (MIME type: ${mimeType || 'unknown'})`);
                }

                const resolvedUrl = foundFile.blobPath
                    ? await getSignedFileUrl(foundFile.blobPath, 60) || foundFile.url
                    : foundFile.url;
                if (!resolvedUrl) {
                    throw new Error(`No URL available for "${foundFile.filename || args.file}"`);
                }
                
                // Prepare avatar image data
                const avatarImage = {
                    url: resolvedUrl,
                    filename: foundFile.filename || foundFile.displayFilename || null,
                    blobPath: foundFile.blobPath || null,
                    contextId: foundFile._contextId || null
                };
                
                // Update entity with new avatar
                const entityStore = getEntityStore();
                const updatedEntity = {
                    ...entityConfig,
                    avatar: {
                        ...(entityConfig.avatar || {}),
                        image: avatarImage
                    }
                };
                
                const updatedEntityId = await entityStore.upsertEntity(updatedEntity);
                if (!updatedEntityId) {
                    throw new Error("Failed to update entity avatar in database");
                }

                pathwayResolver.tool = JSON.stringify({ toolUsed: "SetBaseAvatar" });
                
                return JSON.stringify({
                    success: true,
                    message: `Base avatar updated successfully. The new avatar image will be used as the base for generating avatar variants.`,
                    avatarImage: {
                        url: avatarImage.url,
                        filename: avatarImage.filename,
                        blobPath: avatarImage.blobPath || null,
                    }
                });
            }

            return result;

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            // Return a JSON error object so the entity runtime executor detects the failure
            return JSON.stringify({
                error: true,
                message: e.message ?? String(e)
            });
        }
    }
};
