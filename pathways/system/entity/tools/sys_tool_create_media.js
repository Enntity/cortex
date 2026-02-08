// sys_tool_create_media.js
// Unified media creation tool - images and videos with smart routing
// Replaces: GenerateImage, ModifyImage, CreateAvatarVariant, GenerateVideo

import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, uploadImageToCloud, addFileToCollection, resolveFileParameter, buildFileCreationResponse, ensureShortLivedUrl } from '../../../../lib/fileUtils.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { config } from '../../../../config.js';
import axios from 'axios';

const MEDIA_API_URL = config.get('whisperMediaApiUrl');

/**
 * Download a file from GCS using authenticated request
 */
async function downloadFromGcsUri(gcsUri) {
    if (!gcsUri || !gcsUri.startsWith('gs://')) {
        throw new Error(`Invalid GCS URI: ${gcsUri}`);
    }

    const uriWithoutProtocol = gcsUri.replace('gs://', '');
    const [bucketName, ...objectParts] = uriWithoutProtocol.split('/');
    const objectPath = objectParts.join('/');
    const httpsUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;

    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        throw new Error('GCP auth token helper not available');
    }

    const authToken = await gcpAuthTokenHelper.getAccessToken();

    const response = await axios.get(httpsUrl, {
        responseType: 'arraybuffer',
        timeout: 300000,
        headers: { 'Authorization': `Bearer ${authToken}` }
    });

    return Buffer.from(response.data);
}

/**
 * Extract video info from Veo response
 */
function extractVideoInfo(video) {
    if (video.bytesBase64Encoded) {
        return { type: 'base64', data: video.bytesBase64Encoded, mimeType: video.mimeType || 'video/mp4' };
    } else if (video.gcsUri) {
        return { type: 'gcsUri', data: video.gcsUri, mimeType: video.mimeType || 'video/mp4' };
    }
    return null;
}

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
        contextId: '',
        contextKey: '',
    },
    timeout: 600, // 10 minutes for video generation

    toolDefinition: [{
        type: "function",
        icon: "🎨",
        function: {
            name: "CreateMedia",
            description: `Generate or modify images and videos.

- To CREATE from scratch: just provide a prompt
- To MODIFY/TRANSFORM: attach referenceImages from your file collection
- For SELFIES/SELF-PORTRAITS: set containsMe=true (uses your avatar as reference)
- For ADULT CONTENT: set nsfw=true (images only, no nsfw video support)

Videos are 8-second clips with AI audio. Use sparingly - video is slow and expensive.`,
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["image", "video"],
                        description: "What to create"
                    },
                    prompt: {
                        type: "string",
                        description: "What to create, or how to modify the reference images. Be detailed about style, mood, lighting, composition."
                    },
                    referenceImages: {
                        type: "array",
                        items: { type: "string" },
                        description: "Files to use as reference (hash or filename from your collection). If provided, modifies/transforms these. Max 3 for images, 1 for video."
                    },
                    containsMe: {
                        type: "boolean",
                        description: "Set true if this depicts YOU (auto-injects your avatar as reference)"
                    },
                    nsfw: {
                        type: "boolean",
                        description: "Set true for adult content. Images only - nsfw video not supported."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Prefix for output filename"
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Tags for categorization"
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["type", "prompt", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const chatId = args.chatId || null;
        const mediaType = args.type || 'image';

        try {
            // ═══════════════════════════════════════════════════════════════
            // VALIDATION
            // ═══════════════════════════════════════════════════════════════

            if (mediaType === 'video' && args.nsfw) {
                return JSON.stringify({
                    error: true,
                    message: "NSFW video generation is not supported. Only SFW videos can be created. For adult content, use type='image' instead."
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // RESOLVE REFERENCE IMAGES
            // ═══════════════════════════════════════════════════════════════

            let resolvedReferenceImages = [];

            // If containsMe, inject base avatar as first reference
            if (args.containsMe) {
                const entityId = args.entityId;
                if (!entityId) {
                    return JSON.stringify({
                        error: true,
                        message: "containsMe=true requires entityId. This should be automatically provided by the system."
                    });
                }

                const entityConfig = await loadEntityConfig(entityId);
                if (!entityConfig) {
                    return JSON.stringify({
                        error: true,
                        message: `Entity not found: ${entityId}`
                    });
                }

                const baseAvatar = entityConfig.avatar?.image;
                if (baseAvatar?.url) {
                    // Refresh SAS token for external service consumption
                    if (baseAvatar.hash && MEDIA_API_URL) {
                        const refreshed = await ensureShortLivedUrl(baseAvatar, MEDIA_API_URL, baseAvatar.contextId || null);
                        resolvedReferenceImages.push(refreshed.url);
                    } else {
                        resolvedReferenceImages.push(baseAvatar.url);
                    }
                }
                // If no base avatar, we'll generate from scratch but they'll look generic
            }

            // Resolve any explicitly provided reference images
            if (args.referenceImages && Array.isArray(args.referenceImages) && args.referenceImages.length > 0) {
                if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                    return JSON.stringify({
                        error: true,
                        message: "referenceImages requires file context. Use FileCollection to find available files."
                    });
                }

                // Limit based on media type, accounting for avatar already added
                const maxRefs = mediaType === 'video' ? 1 : 3;
                const remainingSlots = maxRefs - resolvedReferenceImages.length;
                const imagesToProcess = args.referenceImages.slice(0, Math.max(0, remainingSlots));

                for (const imageRef of imagesToProcess) {
                    const resolved = await resolveFileParameter(imageRef, args.agentContext);
                    if (!resolved) {
                        return JSON.stringify({
                            error: true,
                            message: `File not found: "${imageRef}". Use FileCollection to find available files.`
                        });
                    }
                    resolvedReferenceImages.push(resolved);
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // ROUTE: VIDEO
            // ═══════════════════════════════════════════════════════════════

            if (mediaType === 'video') {
                return await generateVideo(args, resolvedReferenceImages, pathwayResolver, chatId);
            }

            // ═══════════════════════════════════════════════════════════════
            // ROUTE: IMAGE (generate or modify)
            // ═══════════════════════════════════════════════════════════════

            const isModify = resolvedReferenceImages.length > 0;

            if (isModify) {
                return await modifyImage(args, resolvedReferenceImages, pathwayResolver, chatId);
            } else {
                return await generateImage(args, pathwayResolver, chatId);
            }

        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return JSON.stringify({
                error: true,
                message: e.message ?? String(e)
            });
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE GENERATION (from scratch)
// ═══════════════════════════════════════════════════════════════════════════

async function generateImage(args, pathwayResolver, chatId) {
    // Select model based on nsfw flag
    // SFW: Gemini Flash Image (nano-banana) - fast and high quality
    // NSFW: Flux (replicate) - supports adult content
    const model = args.nsfw ? "replicate-flux-dev" : "gemini-flash-25-image";
    const pathwayName = args.nsfw ? "image_flux" : "image_gemini_25";

    const params = {
        ...args,
        text: args.prompt,
        model,
        stream: false,
    };

    // NSFW: disable safety checker
    if (args.nsfw) {
        params.disable_safety_checker = true;
    }

    pathwayResolver.tool = JSON.stringify({ toolUsed: "CreateMedia", action: "generate", type: "image" });

    let result = await callPathway(pathwayName, params, pathwayResolver);

    // Process and upload artifacts
    result = await processImageArtifacts(result, args, pathwayResolver, chatId, 'generated');

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE MODIFICATION (with reference images)
// ═══════════════════════════════════════════════════════════════════════════

async function modifyImage(args, resolvedReferenceImages, pathwayResolver, chatId) {
    const model = "replicate-qwen-image-edit-2511";

    const params = {
        ...args,
        text: args.prompt,
        model,
        stream: false,
        aspectRatio: "match_input_image",
    };

    // Set input images (qwen supports up to 3)
    if (resolvedReferenceImages[0]) params.input_image = resolvedReferenceImages[0];
    if (resolvedReferenceImages[1]) params.input_image_2 = resolvedReferenceImages[1];
    if (resolvedReferenceImages[2]) params.input_image_3 = resolvedReferenceImages[2];

    // For containsMe (avatar), use square aspect ratio and disable safety
    if (args.containsMe) {
        params.aspectRatio = "1:1";
        params.output_format = "webp";
        params.output_quality = 80;
        params.go_fast = true;
        params.disable_safety_checker = true;
    }

    // NSFW: disable safety checker
    if (args.nsfw) {
        params.disable_safety_checker = true;
    }

    pathwayResolver.tool = JSON.stringify({
        toolUsed: "CreateMedia",
        action: args.containsMe ? "avatar" : "modify",
        type: "image"
    });

    let result = await callPathway('image_qwen', params, pathwayResolver);

    // Process and upload artifacts
    const actionLabel = args.containsMe ? 'avatar' : 'modified';
    result = await processImageArtifacts(result, args, pathwayResolver, chatId, actionLabel);

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIDEO GENERATION
// ═══════════════════════════════════════════════════════════════════════════

async function generateVideo(args, resolvedReferenceImages, pathwayResolver, chatId) {
    const params = {
        ...args,
        text: args.prompt,
        model: 'gemini-veo-31-flash',
        stream: false,
    };

    // If reference image provided, use it as starting frame
    if (resolvedReferenceImages[0]) {
        params.input_image = resolvedReferenceImages[0];
    }

    pathwayResolver.tool = JSON.stringify({ toolUsed: "CreateMedia", action: "generate", type: "video" });

    const result = await callPathway('video_veo', params, pathwayResolver);

    // Process video artifacts
    if (pathwayResolver.pathwayResultData?.generatedVideos) {
        const videos = pathwayResolver.pathwayResultData.generatedVideos;
        const uploadedVideos = [];

        for (const video of videos) {
            const videoInfo = extractVideoInfo(video);
            if (!videoInfo) continue;

            try {
                let videoBuffer;
                if (videoInfo.type === 'base64') {
                    videoBuffer = Buffer.from(videoInfo.data, 'base64');
                } else if (videoInfo.type === 'gcsUri') {
                    videoBuffer = await downloadFromGcsUri(videoInfo.data);
                }

                if (videoBuffer) {
                    const uploadResult = await uploadFileToCloud(
                        videoBuffer,
                        videoInfo.mimeType,
                        null,
                        pathwayResolver,
                        args.contextId
                    );

                    const uploadedUrl = uploadResult.url || uploadResult;
                    const uploadedGcs = uploadResult.gcs || null;
                    const uploadedHash = uploadResult.hash || null;

                    // Add to file collection
                    if (args.contextId && uploadedUrl) {
                        const extension = videoInfo.mimeType.split('/')[1] || 'mp4';
                        const uniqueId = uploadedHash ? uploadedHash.substring(0, 8) : Date.now();
                        const filenamePrefix = args.filenamePrefix || 'generated-video';
                        const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                        const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;

                        const defaultTags = ['video', 'generated'];
                        const providedTags = Array.isArray(args.tags) ? args.tags : [];
                        const allTags = [...defaultTags, ...providedTags.filter(t => !defaultTags.includes(t))];

                        const fileEntry = await addFileToCollection(
                            args.contextId,
                            args.contextKey || '',
                            uploadedUrl,
                            uploadedGcs,
                            filename,
                            allTags,
                            `Generated video: ${args.prompt?.substring(0, 100) || 'video generation'}`,
                            uploadedHash,
                            null,
                            pathwayResolver,
                            true,
                            chatId,
                            args.entityId || null
                        );

                        uploadedVideos.push({
                            type: 'video',
                            url: uploadedUrl,
                            gcs: uploadedGcs,
                            hash: uploadedHash,
                            mimeType: videoInfo.mimeType,
                            fileEntry
                        });
                    }
                }
            } catch (uploadError) {
                pathwayResolver.logError(`Failed to upload video: ${uploadError.message}`);
            }
        }

        if (uploadedVideos.length > 0) {
            const response = buildFileCreationResponse(uploadedVideos, {
                mediaType: 'video',
                action: 'Video generation'
            });

            // Parse and add display reminder (different for voice mode)
            try {
                const parsed = JSON.parse(response);
                parsed.displayReminder = args.voiceResponse
                    ? "IMPORTANT: Show this video to the user with ShowOverlay! Include a 'narrative' parameter with what you'll say while showing it."
                    : "IMPORTANT: Show this video to the user! Use ShowOverlay or include in your response as markdown: ![description](url)";
                return JSON.stringify(parsed);
            } catch {
                return response;
            }
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED: Process image artifacts from Replicate
// ═══════════════════════════════════════════════════════════════════════════

async function processImageArtifacts(result, args, pathwayResolver, chatId, actionLabel) {
    if (!pathwayResolver.pathwayResultData?.artifacts) return result;

    const artifacts = pathwayResolver.pathwayResultData.artifacts;
    if (!Array.isArray(artifacts)) return result;

    const uploadedImages = [];

    for (const artifact of artifacts) {
        // Handle both Gemini (data) and Replicate (url) artifact formats
        if (artifact.type !== 'image') continue;
        if (!artifact.data && !artifact.url) continue;

        try {
            const mimeType = artifact.mimeType || 'image/png';

            let uploadResult;
            if (artifact.data) {
                // Gemini format: base64 data
                uploadResult = await uploadImageToCloud(
                    artifact.data,
                    mimeType,
                    pathwayResolver,
                    args.contextId
                );
            } else {
                // Replicate format: URL
                uploadResult = await uploadFileToCloud(
                    artifact.url,
                    mimeType,
                    null,
                    pathwayResolver,
                    args.contextId
                );
            }

            const uploadedUrl = uploadResult.url || uploadResult;
            const uploadedGcs = uploadResult.gcs || null;
            const uploadedHash = uploadResult.hash || null;

            const imageData = {
                type: 'image',
                url: uploadedUrl,
                gcs: uploadedGcs,
                hash: uploadedHash,
                mimeType
            };

            // Add to file collection
            if (args.contextId && uploadedUrl) {
                const extension = mimeType.split('/')[1] || 'png';
                const uniqueId = uploadedHash ? uploadedHash.substring(0, 8) : Date.now();
                const defaultPrefix = actionLabel === 'avatar' ? 'avatar-image' :
                                     actionLabel === 'modified' ? 'modified-image' : 'generated-image';
                const filenamePrefix = args.filenamePrefix || defaultPrefix;
                const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                const filename = `${sanitizedPrefix}-${uniqueId}.${extension}`;

                const defaultTags = ['image', actionLabel];
                const providedTags = Array.isArray(args.tags) ? args.tags : [];
                const allTags = [...defaultTags, ...providedTags.filter(t => !defaultTags.includes(t))];

                const fileEntry = await addFileToCollection(
                    args.contextId,
                    args.contextKey || '',
                    uploadedUrl,
                    uploadedGcs,
                    filename,
                    allTags,
                    `${actionLabel} image: ${args.prompt?.substring(0, 100) || 'image'}`,
                    uploadedHash,
                    null,
                    pathwayResolver,
                    true,
                    chatId,
                    args.entityId || null
                );

                imageData.fileEntry = fileEntry;
            }

            uploadedImages.push(imageData);
        } catch (uploadError) {
            pathwayResolver.logError(`Failed to upload image: ${uploadError.message}`);
            // Only add fallback if we have a URL (Replicate), not for base64 data (Gemini)
            if (artifact.url) {
                uploadedImages.push({ type: 'image', url: artifact.url, mimeType: artifact.mimeType || 'image/png' });
            }
        }
    }

    if (uploadedImages.length > 0) {
        const successfulImages = uploadedImages.filter(img => img.url);
        if (successfulImages.length > 0) {
            const imageUrls = successfulImages.map(img => ({
                type: "image_url",
                url: img.fileEntry?.url || img.url,
                gcs: img.fileEntry?.gcs || img.gcs,
                image_url: { url: img.fileEntry?.url || img.url },
                hash: img.fileEntry?.hash || img.hash || null
            }));

            const actionText = actionLabel === 'avatar' ? 'Avatar generation' :
                              actionLabel === 'modified' ? 'Image modification' : 'Image generation';

            const response = buildFileCreationResponse(successfulImages, {
                mediaType: 'image',
                action: actionText,
                legacyUrls: imageUrls
            });

            // Parse and add display reminder
            try {
                const parsed = JSON.parse(response);
                parsed.displayReminder = args.voiceResponse
                    ? "IMPORTANT: Show this image to the user with ShowOverlay! Include a 'narrative' parameter with what you'll say while showing it."
                    : "IMPORTANT: Show this image to the user! Use ShowOverlay or include in your response as markdown: ![description](url)";
                return JSON.stringify(parsed);
            } catch {
                return response;
            }
        }
    }

    // No artifacts generated - likely safety filter
    if (uploadedImages.length === 0) {
        throw new Error('No images generated. Content may have been blocked by safety filters. Try a different prompt or set nsfw=true for adult content.');
    }

    return result;
}
