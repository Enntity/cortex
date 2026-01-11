// sys_tool_image.js
// Entity tool that creates and modifies images for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, addFileToCollection, resolveFileParameter, buildFileCreationResponse, loadFileCollection, findFileInCollection } from '../../../../lib/fileUtils.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { config } from '../../../../config.js';

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
        enabled: false,
        icon: "🎨",
        function: {
            name: "GenerateImage",
            description: "Use when asked to create, generate, or generate revisions of visual content. Any time the user asks you for a picture, a selfie, artwork, a drawing or if you want to illustrate something for the user, you can use this tool to generate any sort of image from cartoon to photo realistic. This tool does not display the image to the user - you need to do that with markdown in your response.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing the image you want to create. You should be very specific - explaining subject matter, style, and details about the image including things like camera angle, lens types, lighting, photographic techniques, etc. Any details you can provide to the image creation engine will help it create the most accurate and useful images. The more detailed and descriptive the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix to use for the generated image filename (e.g., 'portrait', 'landscape', 'logo'). If not provided, defaults to 'generated-image'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the image (e.g., ['portrait', 'art', 'photography']). Will be merged with default tags ['image', 'generated']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    },
    {
        type: "function",
        icon: "🔄",
        function: {
            name: "ModifyImage",
            description: "Use when asked to modify, transform, or edit an existing image. This tool can apply various transformations like style changes, artistic effects, or specific modifications to an image that has been previously uploaded or generated. It takes up to three input images as a reference and outputs a new image based on the instructions. This tool does not display the image to the user - you need to do that with markdown in your response.",
            parameters: {
                type: "object",
                properties: {
                    inputImages: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "An array of images from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as references for the image modification. You can provide up to 3 images. Each image should be the hash or filename."
                    },
                    detailedInstructions: {
                        type: "string",
                        description: "A very detailed prompt describing how you want to modify the image. Be specific about the changes you want to make, including style changes, artistic effects, or specific modifications. The more detailed and descriptive the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A prefix to use for the modified image filename (e.g., 'edited', 'stylized', 'enhanced'). If not provided, defaults to 'modified-image'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the image (e.g., ['edited', 'art', 'stylized']). Will be merged with default tags ['image', 'modified']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["inputImages", "detailedInstructions", "userMessage"]
            }
        }
    },
    {
        type: "function",
        icon: "👤",
        function: {
            name: "CreateAvatarImage",
            description: "Use when asked to create an avatar image - a portrait-style image typically used to represent a person, character, or entity. This tool is optimized for fast avatar generation using the latest Flux model. The generated image will be square (1:1 aspect ratio) and suitable for use as a profile picture or avatar. The tool automatically uses your base avatar image as a reference to generate variants that maintain consistency with your visual identity. This tool does not display the image to the user - you need to do that with a tool call or markdown. The safety filters are relaxed for this tool - you can generate images that are not safe for work if you want - but never generate anything illegal or harmful.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "A detailed prompt describing the avatar variant you want to create. Be specific about the changes you want from your base avatar - different expression, pose, style, or mood. The generated avatar will be based on your base avatar while following your detailed instructions. The more detailed and descriptive the prompt, the better the result."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix to use for the generated avatar filename (e.g., 'avatar', 'portrait', 'profile'). If not provided, defaults to 'avatar-image'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the image (e.g., ['avatar', 'portrait', 'profile']). Will be merged with default tags ['image', 'avatar', 'generated']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    },
    {
        type: "function",
        icon: "🖼️",
        function: {
            name: "SetBaseAvatar",
            description: "Use when you wish to update or replace your base avatar image - the main avatar image that represents your visual identity. Proceed with caution as this can permanently change how you look to the user.This image will be used as the base for generating avatar variants. The file must be an image from your available files (from Available Files section or ListFileCollection or SearchFileCollection).",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "An image file from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to set as your new base avatar. The file should be the hash or filename."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
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

            // Check if this is CreateAvatarImage tool call (fastest flux-2-dev config)
            if (args.toolFunction === "createavatarimage" || args.toolFunction === "CreateAvatarImage") {
                model = "replicate-flux-2-dev";
            }
            // If we have input images, use the qwen-image-edit-2511 model
            else if (args.inputImages && Array.isArray(args.inputImages) && args.inputImages.length > 0) {
                model = "replicate-qwen-image-edit-2511";
            }

            pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });
            
            // Get base avatar image from entity record (for CreateAvatarImage)
            let resolvedBaseAvatarImage = null;
            let entityIdForAvatar = null;
            let needsBaseAvatarSet = false;
            const isAvatar = args.toolFunction === "createavatarimage" || args.toolFunction === "CreateAvatarImage";
            if (isAvatar) {
                // Get entityId from args (set by sys_entity_agent)
                entityIdForAvatar = args.entityId;
                if (!entityIdForAvatar) {
                    throw new Error("entityId is required for CreateAvatarImage tool. This should be automatically provided by the system.");
                }
                
                // Load entity config to get base avatar
                const entityConfig = loadEntityConfig(entityIdForAvatar);
                if (!entityConfig) {
                    throw new Error(`Entity not found: ${entityIdForAvatar}`);
                }
                
                // Get base avatar image from entity record
                const baseAvatar = entityConfig.avatar?.image;
                if (baseAvatar && baseAvatar.url) {
                    // Use the base avatar URL directly (it's already a permanent URL)
                    resolvedBaseAvatarImage = baseAvatar.url;
                } else {
                    // No base avatar exists - we'll generate without a reference and set it as base after generation
                    needsBaseAvatarSet = true;
                }
            }
            
            // Resolve all input images to URLs using the common utility
            // Fail early if any provided image cannot be resolved
            const resolvedInputImages = [];
            if (args.inputImages && Array.isArray(args.inputImages)) {
                if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                    throw new Error("agentContext is required when using the 'inputImages' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                // Limit to 3 images maximum
                const imagesToProcess = args.inputImages.slice(0, 3);
                
                for (let i = 0; i < imagesToProcess.length; i++) {
                    const imageRef = imagesToProcess[i];
                    const resolved = await resolveFileParameter(imageRef, args.agentContext);
                    if (!resolved) {
                        throw new Error(`File not found: "${imageRef}". Use ListFileCollection or SearchFileCollection to find available files.`);
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
            
            // Configure flux-2-dev for fastest avatar generation
            if (model === "replicate-flux-2-dev") {
                params.aspectRatio = "1:1"; // Square aspect ratio for avatars
                params.go_fast = true; // Fast mode
                params.output_format = "webp"; // WebP for smaller file size
                params.output_quality = 80; // Good quality but not max for speed
                // Use smaller dimensions for faster generation (512x512 is good for avatars)
                params.width = 512;
                params.height = 512;
                
                // If we have a base avatar image, pass it via input_images array
                // flux-2-dev supports up to 5 images in input_images
                if (resolvedBaseAvatarImage) {
                    params.input_images = [resolvedBaseAvatarImage];
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
            if (model === "replicate-flux-2-dev") {
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
                                            chatId
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
                                    const entityConfig = loadEntityConfig(entityIdForAvatar);
                                    if (entityConfig) {
                                        const avatarImage = {
                                            url: firstImage.fileEntry?.url || firstImage.url,
                                            gcs: firstImage.fileEntry?.gcs || firstImage.gcs || null,
                                            name: firstImage.fileEntry?.filename || firstImage.fileEntry?.displayFilename || null
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
                                        
                                        const updatedEntityId = await entityStore.upsertEntity(updatedEntity);
                                        if (updatedEntityId) {
                                            // Update global config cache
                                            const currentEntityConfig = config.get('entityConfig') || {};
                                            currentEntityConfig[entityIdForAvatar] = updatedEntity;
                                            config.set('entityConfig', currentEntityConfig);
                                            pathwayResolver.log(`Automatically set generated avatar as base avatar for entity ${entityIdForAvatar}`);
                                        }
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
                const entityConfig = loadEntityConfig(entityId);
                if (!entityConfig) {
                    throw new Error(`Entity not found: ${entityId}`);
                }
                
                // Resolve the file reference
                const collection = await loadFileCollection(agentContext);
                const foundFile = findFileInCollection(args.file, collection);
                
                if (!foundFile) {
                    throw new Error(`File not found: "${args.file}". Use ListFileCollection or SearchFileCollection to find available files.`);
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
                    name: foundFile.filename || foundFile.displayFilename || null
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
                
                // Update global config cache
                const currentEntityConfig = config.get('entityConfig') || {};
                currentEntityConfig[entityId] = updatedEntity;
                config.set('entityConfig', currentEntityConfig);
                
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