// sys_tool_image.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, addFileToCollection, resolveFileParameter, buildFileCreationResponse, loadFileCollection, findFileInCollection, ensureShortLivedUrl } from '../../../../lib/fileUtils.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { config } from '../../../../config.js';

const MEDIA_API_URL = config.get('whisperMediaApiUrl');

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
                        description: "An image file from your available files (from Available Files section or FileCollection) to set as your new base avatar. The file should be the hash or filename."
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
                // Get entityId from args (set by sys_entity_agent)
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
                    // Refresh SAS token for external service consumption
                    if (baseAvatar.hash && MEDIA_API_URL) {
                        const refreshed = await ensureShortLivedUrl(baseAvatar, MEDIA_API_URL, baseAvatar.contextId || null);
                        resolvedBaseAvatarImage = refreshed.url;
                    } else {
                        resolvedBaseAvatarImage = baseAvatar.url;
                    }
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
                    throw new Error("agentContext is required when using the 'inputImages' parameter. Use FileCollection to find available files.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, args.agentContext);
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use FileCollection to find available files.`);
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
                                
                                // Upload image to cloud storage (downloads from URL, computes hash, uploads)
                                const uploadResult = await uploadFileToCloud(
                                    imageUrl,
                                    mimeType,
                                    null, // filename will be generated
                                    pathwayResolver,
                                    args.contextId
                                );
                                
                                const uploadedUrl = uploadResult.url || uploadResult;
                                const uploadedGcs = uploadResult.gcs || null;
                                const uploadedHash = uploadResult.hash || null;
                                
                                const imageData = {
                                    type: 'image',
                                    url: uploadedUrl,
                                    gcs: uploadedGcs,
                                    hash: uploadedHash,
                                    mimeType: mimeType
                                };
                                
                                // Add uploaded image to file collection if contextId is available
                                if (args.contextId && uploadedUrl) {
                                    try {
                                        // Generate filename from mimeType (e.g., "image/png" -> "png")
                                        const extension = mimeType.split('/')[1] || 'png';
                                        // Use hash for uniqueness if available, otherwise use timestamp and index
                                        const uniqueId = uploadedHash ? uploadedHash.substring(0, 8) : `${Date.now()}-${uploadedImages.length}`;
                                        
                                        // Determine filename prefix based on whether this is a modification, avatar, or generation
                                        const isModification = args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0;
                                        const isAvatar = args.toolFunction === "createavatarimage" || args.toolFunction === "CreateAvatarImage";
                                        const defaultPrefix = isModification ? 'modified-image' : (isAvatar ? 'avatar-image' : 'generated-image');
                                        const filenamePrefix = args.filenamePrefix || defaultPrefix;
                                        
                                        // Sanitize the prefix to ensure it's a valid filename component
                                        const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                                        const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;
                                        
                                        // Merge provided tags with default tags
                                        const defaultTags = ['image', isModification ? 'modified' : (isAvatar ? 'avatar' : 'generated'), ...(isAvatar ? [] : [])];
                                        const providedTags = Array.isArray(args.tags) ? args.tags : [];
                                        const allTags = [...defaultTags, ...providedTags.filter(tag => !defaultTags.includes(tag))];
                                        
                                        // Use the centralized utility function to add to collection - capture returned entry
                                        const fileEntry = await addFileToCollection(
                                            args.contextId,
                                            args.contextKey || '',
                                            uploadedUrl,
                                            uploadedGcs,
                                            filename,
                                            allTags,
                                            isModification 
                                                ? `Modified image from prompt: ${args.detailedInstructions || 'image modification'}`
                                                : `Generated image from prompt: ${args.detailedInstructions || 'image generation'}`,
                                            uploadedHash,
                                            null, // fileUrl - not needed since we already uploaded
                                            pathwayResolver,
                                            true, // permanent => retention=permanent
                                            chatId,
                                            args.entityId || null
                                        );
                                        
                                        // Use the file entry data for the return message
                                        imageData.fileEntry = fileEntry;
                                    } catch (collectionError) {
                                        // Log but don't fail - file collection is optional
                                        pathwayResolver.logWarning(`Failed to add image to file collection: ${collectionError.message}`);
                                    }
                                }
                                
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
                                const url = img.fileEntry?.url || img.url;
                                const gcs = img.fileEntry?.gcs || img.gcs;
                                const hash = img.fileEntry?.hash || img.hash;
                                
                                return {
                                    type: "image_url",
                                    url: url,
                                    gcs: gcs || null,
                                    image_url: { url: url },
                                    hash: hash || null
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
                                            url: firstImage.fileEntry?.url || firstImage.url,
                                            gcs: firstImage.fileEntry?.gcs || firstImage.gcs || null,
                                            name: firstImage.fileEntry?.filename || firstImage.fileEntry?.displayFilename || null,
                                            hash: firstImage.fileEntry?.hash || firstImage.hash || null,
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
                                legacyUrls: imageUrls
                            });
                        }
                    }
                }
            }

            // Handle SetBaseAvatar tool call
            if (args.toolFunction === "setbaseavatar" || args.toolFunction === "SetBaseAvatar") {
                // Get entityId from args (set by sys_entity_agent)
                const entityId = args.entityId;
                if (!entityId) {
                    throw new Error("entityId is required for SetBaseAvatar tool. This should be automatically provided by the system.");
                }
                
                // Validate required parameters
                if (!args.file) {
                    throw new Error("file parameter is required for SetBaseAvatar tool.");
                }
                
                // agentContext should be provided by sys_entity_agent via args
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
                    throw new Error(`File not found: "${args.file}". Use FileCollection to find available files.`);
                }
                
                // Validate it's an image
                const mimeType = foundFile.mimeType || foundFile.contentType || '';
                const isImage = mimeType.startsWith('image/') || 
                              /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(foundFile.filename || '');
                
                if (!isImage) {
                    throw new Error(`File "${foundFile.filename || args.file}" is not an image file (MIME type: ${mimeType || 'unknown'})`);
                }
                
                // Prepare avatar image data
                const avatarImage = {
                    url: foundFile.url,
                    gcs: foundFile.gcs || null,
                    name: foundFile.filename || foundFile.displayFilename || null,
                    hash: foundFile.hash || null,
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
                        gcs: avatarImage.gcs,
                        name: avatarImage.name
                    }
                });
            }

            return result;

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            // Return a JSON error object so sys_entity_agent detects the failure
            return JSON.stringify({
                error: true,
                message: e.message ?? String(e)
            });
        }
    }
};