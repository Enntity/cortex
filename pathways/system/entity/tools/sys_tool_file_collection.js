// sys_tool_file_collection.js
// Tool pathway that manages user file collections (add, search, list, update, remove files)
// Uses Redis hash maps (FileStoreMap:ctx:<contextId>) for storage
// Unified tool with smart routing based on parameters
import logger from '../../../../lib/logger.js';
import { addFileToCollection, loadFileCollection, findFileInCollection, deleteFileByHash, updateFileMetadata, invalidateFileCollectionCache } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: [
        {
            type: "function",
            icon: "📁",
            function: {
                name: "FileCollection",
                description: `Manage your file collection. Operations are inferred from parameters:
• ADD: Provide fileUrl (to upload) or url (already uploaded) + filename
• SEARCH: Provide query to search by filename, tags, or notes
• LIST: No query/fileUrl/url/fileIds/file → lists all files
• REMOVE: Provide fileIds array to delete files
• UPDATE: Provide file + any of: newFilename, tags, addTags, removeTags, notes, permanent`,
                parameters: {
                    type: "object",
                    properties: {
                        // === ADD parameters ===
                        fileUrl: {
                            type: "string",
                            description: "ADD: URL of a file to upload to cloud storage (e.g., https://example.com/file.pdf)"
                        },
                        url: {
                            type: "string",
                            description: "ADD: Cloud storage URL of an already-uploaded file (use if file is already in cloud)"
                        },
                        gcs: {
                            type: "string",
                            description: "ADD: Google Cloud Storage URL (only if providing 'url')"
                        },
                        filename: {
                            type: "string",
                            description: "ADD: Filename or title for the file being added"
                        },
                        hash: {
                            type: "string",
                            description: "ADD: File hash for deduplication (usually computed automatically)"
                        },
                        // === SEARCH parameters ===
                        query: {
                            type: "string",
                            description: "SEARCH: Search query - searches filename, tags, and notes (case-insensitive substring match)"
                        },
                        // === REMOVE parameters ===
                        fileIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "REMOVE: Array of files to delete (hash, filename, or URL)"
                        },
                        // === UPDATE parameters ===
                        file: {
                            type: "string",
                            description: "UPDATE: The file to update (filename, hash, or URL)"
                        },
                        newFilename: {
                            type: "string",
                            description: "UPDATE: New filename/title for the file"
                        },
                        addTags: {
                            type: "array",
                            items: { type: "string" },
                            description: "UPDATE: Tags to add to existing tags"
                        },
                        removeTags: {
                            type: "array",
                            items: { type: "string" },
                            description: "UPDATE: Tags to remove from existing tags"
                        },
                        // === Shared parameters ===
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "ADD: Tags for new file. UPDATE: Replace all tags. SEARCH/LIST: Filter by tags."
                        },
                        notes: {
                            type: "string",
                            description: "ADD/UPDATE: Notes or description for the file"
                        },
                        permanent: {
                            type: "boolean",
                            description: "ADD/UPDATE: If true, file won't be auto-cleaned"
                        },
                        sortBy: {
                            type: "string",
                            enum: ["date", "filename"],
                            description: "LIST: Sort by date (newest first) or filename. Default: date"
                        },
                        limit: {
                            type: "number",
                            description: "SEARCH/LIST: Maximum results to return (default: 20 for search, 50 for list)"
                        },
                        includeAllChats: {
                            type: "boolean",
                            description: "SEARCH/LIST: Set true to include files from all chats"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message describing what you're doing"
                        }
                    },
                    required: ["userMessage"]
                }
            }
        },
        // Legacy tool definitions (disabled - use FileCollection instead)
        {
            type: "function",
            enabled: false,
            icon: "📁",
            function: {
                name: "AddFileToCollection",
                description: "DEPRECATED: Use FileCollection with fileUrl/url + filename instead.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            enabled: false,
            icon: "🔍",
            function: {
                name: "SearchFileCollection",
                description: "DEPRECATED: Use FileCollection with query parameter instead.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            enabled: false,
            icon: "📋",
            function: {
                name: "ListFileCollection",
                description: "DEPRECATED: Use FileCollection with no action parameters instead.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            enabled: false,
            icon: "🗑️",
            function: {
                name: "RemoveFileFromCollection",
                description: "DEPRECATED: Use FileCollection with fileIds parameter instead.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            enabled: false,
            icon: "✏️",
            function: {
                name: "UpdateFileMetadata",
                description: "DEPRECATED: Use FileCollection with file + metadata parameters instead.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { contextId, contextKey } = args;
        if (!contextId) {
            throw new Error("contextId is required. It should be provided via agentContext or contextId parameter.");
        }
        const chatId = args.chatId || null;

        // Determine which function was called based on which parameters are present
        // Order matters: check most specific operations first
        const isUpdate = args.file !== undefined && (
            args.newFilename !== undefined || 
            args.tags !== undefined || 
            args.addTags !== undefined || 
            args.removeTags !== undefined || 
            args.notes !== undefined || 
            args.permanent !== undefined
        );
        const isAdd = !isUpdate && (args.fileUrl !== undefined || args.url !== undefined);
        const isSearch = args.query !== undefined;
        const isRemove = args.fileIds !== undefined || args.fileId !== undefined;

        try {
            if (!contextId) {
                throw new Error("contextId is required for file collection operations");
            }

            if (isUpdate) {
                // Update file metadata (rename, tags, notes, permanent)
                const { file, newFilename, tags, addTags, removeTags, notes, permanent } = args;
                
                if (!file) {
                    throw new Error("file parameter is required - specify the file by filename, hash, URL, or ID");
                }

                // Load collection and find the file
                // Use loadFileCollection without chatIds to find files regardless of inCollection status
                // This ensures files can be updated even if they're chat-specific
                const collection = await loadFileCollection({ contextId, contextKey, default: true });
                const foundFile = findFileInCollection(file, collection);
                
                if (!foundFile) {
                    throw new Error(`File not found: "${file}". Use ListFileCollection to see available files.`);
                }

                if (!foundFile.hash) {
                    throw new Error(`File "${file}" has no hash - cannot update metadata`);
                }

                // Build the metadata update object
                const metadataUpdate = {};
                
                // Handle filename rename
                if (newFilename !== undefined) {
                    metadataUpdate.displayFilename = newFilename;
                }
                
                // Handle tags - three modes: replace all, add, or remove
                if (tags !== undefined) {
                    // Replace all tags
                    metadataUpdate.tags = Array.isArray(tags) ? tags : [];
                } else if (addTags !== undefined || removeTags !== undefined) {
                    // Merge with existing tags
                    let currentTags = Array.isArray(foundFile.tags) ? [...foundFile.tags] : [];
                    
                    // Add new tags (avoid duplicates)
                    if (addTags && Array.isArray(addTags)) {
                        for (const tag of addTags) {
                            const normalizedTag = tag.toLowerCase();
                            if (!currentTags.some(t => t.toLowerCase() === normalizedTag)) {
                                currentTags.push(tag);
                            }
                        }
                    }
                    
                    // Remove tags
                    if (removeTags && Array.isArray(removeTags)) {
                        const removeSet = new Set(removeTags.map(t => t.toLowerCase()));
                        currentTags = currentTags.filter(t => !removeSet.has(t.toLowerCase()));
                    }
                    
                    metadataUpdate.tags = currentTags;
                }
                
                // Handle notes
                if (notes !== undefined) {
                    metadataUpdate.notes = notes;
                }
                
                // Handle permanent flag
                if (permanent !== undefined) {
                    metadataUpdate.permanent = permanent;
                }
                
                // Always update lastAccessed
                metadataUpdate.lastAccessed = new Date().toISOString();

                // Perform the atomic update
                const success = await updateFileMetadata(contextId, foundFile.hash, metadataUpdate, contextKey, chatId);
                
                if (!success) {
                    throw new Error(`Failed to update file metadata for "${file}"`);
                }

                // Build result with what was updated
                const updates = [];
                if (newFilename !== undefined) updates.push(`renamed to "${newFilename}"`);
                if (tags !== undefined) updates.push(`tags set to [${tags.join(', ')}]`);
                if (addTags !== undefined) updates.push(`added tags [${addTags.join(', ')}]`);
                if (removeTags !== undefined) updates.push(`removed tags [${removeTags.join(', ')}]`);
                if (notes !== undefined) updates.push(`notes updated`);
                if (permanent !== undefined) updates.push(`marked as ${permanent ? 'permanent' : 'temporary'}`);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "update" });
                return JSON.stringify({
                    success: true,
                    file: foundFile.displayFilename || foundFile.filename || file,
                    fileId: foundFile.id,
                    hash: foundFile.hash,
                    updates: updates,
                    message: `File "${foundFile.displayFilename || foundFile.filename || file}" updated: ${updates.join(', ')}`
                });

            } else if (isAdd) {
                // Add file to collection
                const { fileUrl, url, gcs, filename, tags = [], notes = '', hash = null, permanent = false } = args;
                
                if (!filename) {
                    throw new Error("filename is required");
                }
                
                if (!fileUrl && !url) {
                    throw new Error("Either fileUrl (to upload) or url (already uploaded) is required");
                }

                // Use the centralized utility function (it will handle upload if fileUrl is provided)
                const fileEntry = await addFileToCollection(
                    contextId,
                    contextKey,
                    url,
                    gcs,
                    filename,
                    tags,
                    notes,
                    hash,
                    fileUrl,
                    resolver,
                    permanent,
                    chatId,
                    args.entityId || null
                );

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "add" });
                return JSON.stringify({
                    success: true,
                    fileId: fileEntry.id,
                    message: `File "${filename}" added to collection`
                });

            } else if (isSearch) {
                // Search collection
                const { query, tags: filterTags = [], limit = 20, includeAllChats = false } = args;
                
                if (!query || typeof query !== 'string') {
                    throw new Error("query is required and must be a string");
                }

                // Ensure filterTags is always an array
                const safeFilterTags = Array.isArray(filterTags) ? filterTags : [];
                const queryLower = query.toLowerCase();
                
                // Normalize query for flexible matching: treat spaces, dashes, underscores as equivalent
                const normalizeForSearch = (str) => str.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
                const queryNormalized = normalizeForSearch(query);
                
                // Determine which chatId to use for filtering (null if includeAllChats is true)
                const filterChatId = includeAllChats ? null : chatId;
                
                // Load primary collection for lastAccessed updates (only update files in primary context)
                const primaryFiles = await loadFileCollection(
                    { contextId, contextKey, default: true }, 
                    { chatIds: filterChatId ? [filterChatId] : null, useCache: false }
                );
                const now = new Date().toISOString();
                
                // Find matching files in primary collection and update lastAccessed directly
                for (const file of primaryFiles) {
                    if (!file.hash) continue;
                    
                    // Fallback to filename if displayFilename is not set (for files uploaded before displayFilename was added)
                    const displayFilename = file.displayFilename || file.filename || '';
                    const filenameMatch = normalizeForSearch(displayFilename).includes(queryNormalized);
                    const notesMatch = file.notes && normalizeForSearch(file.notes).includes(queryNormalized);
                    const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => normalizeForSearch(tag).includes(queryNormalized));
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = safeFilterTags.length === 0 || 
                        (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        ));
                    
                    if (matchesQuery && matchesTags) {
                        // Update lastAccessed directly (atomic operation)
                        // Don't pass chatId - we're only updating access time, not changing inCollection
                        await updateFileMetadata(contextId, file.hash, {
                            lastAccessed: now
                        }, contextKey);
                    }
                }
                
                // Load collection for search results (includes all agentContext files)
                // Filter by chatId if includeAllChats is false and chatId is available
                const updatedFiles = await loadFileCollection(
                    args.agentContext, 
                    { chatIds: filterChatId ? [filterChatId] : null }
                );
                
                // Filter and sort results (for display only, not modifying)
                let results = updatedFiles.filter(file => {
                    // Filter by query and tags
                    // Fallback to filename if displayFilename is not set
                    const displayFilename = file.displayFilename || file.filename || '';
                    const filename = file.filename || '';
                    
                    // Check both displayFilename and filename for matches
                    // Use normalized matching (treating spaces, dashes, underscores as equivalent)
                    // so "News Corp" matches "News-Corp" and "News_Corp"
                    const displayFilenameNorm = normalizeForSearch(displayFilename);
                    const filenameNorm = normalizeForSearch(filename);
                    const filenameMatch = displayFilenameNorm.includes(queryNormalized) || 
                                         (filename && filename !== displayFilename && filenameNorm.includes(queryNormalized));
                    const notesMatch = file.notes && normalizeForSearch(file.notes).includes(queryNormalized);
                    const tagMatch = Array.isArray(file.tags) && file.tags.some(tag => normalizeForSearch(tag).includes(queryNormalized));
                    
                    const matchesQuery = filenameMatch || notesMatch || tagMatch;
                    
                    const matchesTags = safeFilterTags.length === 0 || 
                        (Array.isArray(file.tags) && safeFilterTags.every(filterTag => 
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        ));
                    
                    return matchesQuery && matchesTags;
                });

                // Sort by relevance (displayFilename matches first, then by date)
                results.sort((a, b) => {
                    // Fallback to filename if displayFilename is not set
                    const aDisplayFilename = a.displayFilename || a.filename || '';
                    const bDisplayFilename = b.displayFilename || b.filename || '';
                    const aFilenameMatch = normalizeForSearch(aDisplayFilename).includes(queryNormalized);
                    const bFilenameMatch = normalizeForSearch(bDisplayFilename).includes(queryNormalized);
                    if (aFilenameMatch && !bFilenameMatch) return -1;
                    if (!aFilenameMatch && bFilenameMatch) return 1;
                    return new Date(b.addedDate) - new Date(a.addedDate);
                });

                // Limit results
                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "search" });
                
                // Build helpful message when no results found
                let message;
                if (results.length === 0) {
                    const suggestions = [];
                    if (chatId && !includeAllChats) {
                        suggestions.push('try includeAllChats=true to search across all chats');
                    }
                    suggestions.push('use ListFileCollection to see all available files');
                    
                    message = `No files found matching "${query}". Count: 0. Suggestions: ${suggestions.join('; ')}.`;
                } else {
                    message = `Found ${results.length} file(s) matching "${query}". Use the hash or displayFilename to reference files in other tools.`;
                }
                
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    message,
                    files: results.map(f => ({
                        id: f.id,
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        gcs: f.gcs || null,
                        tags: f.tags,
                        notes: f.notes,
                        addedDate: f.addedDate
                    }))
                });

            } else if (isRemove) {
                // Remove file(s) from this chat's collection (reference counting)
                // Only delete from cloud if no other chats reference the file
                const { fileIds, fileId } = args;
                
                // Normalize input to array
                let targetFiles = [];
                if (Array.isArray(fileIds)) {
                    targetFiles = fileIds;
                } else if (fileId) {
                    targetFiles = [fileId];
                }

                if (!targetFiles || targetFiles.length === 0) {
                    throw new Error("fileIds array is required and must not be empty");
                }

                let notFoundFiles = [];
                let filesToProcess = [];

                // Load collection ONCE to find all files and their data
                // Do NOT filter by chatId - remove should be able to delete files from any chat
                // Use loadFileCollection without chatIds to get all files from all contexts
                const collection = await loadFileCollection(args.agentContext);
                
                // Resolve all files and collect their info in a single pass
                for (const target of targetFiles) {
                    if (target === '*') continue; // Skip wildcard if passed
                    
                    const foundFile = findFileInCollection(target, collection);
                    
                    if (foundFile) {
                        // Avoid duplicates (by hash since that's the unique key in Redis)
                        if (!filesToProcess.some(f => f.hash === foundFile.hash)) {
                            filesToProcess.push({
                                id: foundFile.id,
                                displayFilename: foundFile.displayFilename || foundFile.filename || null,
                                hash: foundFile.hash || null,
                                permanent: foundFile.permanent ?? false,
                                inCollection: foundFile.inCollection || []
                            });
                        }
                    } else {
                        notFoundFiles.push(target);
                    }
                }

                if (filesToProcess.length === 0 && notFoundFiles.length > 0) {
                    throw new Error(`No files found matching: ${notFoundFiles.join(', ')}. Try using the file hash, URL, or filename instead of ID. If the file was found in a search, use the hash or filename from the search results.`);
                }

                // Import helpers for reference counting
                const { getRedisClient, removeChatIdFromInCollection } = await import('../../../../lib/fileUtils.js');
                const redisClient = await getRedisClient();
                const contextMapKey = `FileStoreMap:ctx:${contextId}`;
                
                // Track files that will be fully deleted vs just updated
                const filesToFullyDelete = [];
                const filesToUpdate = [];
                
                for (const fileInfo of filesToProcess) {
                    if (!fileInfo.hash) continue;
                    
                    // Check if file is global ('*') - global files can't be removed per-chat
                    const isGlobal = Array.isArray(fileInfo.inCollection) && fileInfo.inCollection.includes('*');
                    
                    if (isGlobal) {
                        // Global file - fully remove it (no reference counting for global files)
                        filesToFullyDelete.push(fileInfo);
                    } else if (!chatId) {
                        // No chatId context - fully remove
                        filesToFullyDelete.push(fileInfo);
                    } else {
                        // Check if current chatId is in the file's inCollection
                        const currentChatInCollection = Array.isArray(fileInfo.inCollection) && fileInfo.inCollection.includes(chatId);
                        
                        if (!currentChatInCollection) {
                            // File doesn't belong to current chat - fully remove it (cross-chat removal)
                            filesToFullyDelete.push(fileInfo);
                        } else {
                            // Remove this chatId from inCollection
                            const updatedInCollection = removeChatIdFromInCollection(fileInfo.inCollection, chatId);
                            
                            if (updatedInCollection.length === 0) {
                                // No more references - fully delete
                                filesToFullyDelete.push(fileInfo);
                            } else {
                                // Still has references from other chats - just update inCollection
                                filesToUpdate.push({ ...fileInfo, updatedInCollection });
                            }
                        }
                    }
                }
                
                // Update files that still have references (remove this chatId only)
                for (const fileInfo of filesToUpdate) {
                    if (redisClient) {
                        try {
                            const existingDataStr = await redisClient.hget(contextMapKey, fileInfo.hash);
                            if (existingDataStr) {
                                const existingData = JSON.parse(existingDataStr);
                                existingData.inCollection = fileInfo.updatedInCollection;
                                await redisClient.hset(contextMapKey, fileInfo.hash, JSON.stringify(existingData));
                                logger.info(`Removed chatId ${chatId} from file: ${fileInfo.displayFilename} (still referenced by: ${fileInfo.updatedInCollection.join(', ')})`);
                            }
                        } catch (e) {
                            logger.warn(`Failed to update inCollection for file ${fileInfo.hash}: ${e.message}`);
                        }
                    }
                }
                
                // Fully delete files with no remaining references
                if (redisClient) {
                    for (const fileInfo of filesToFullyDelete) {
                        await redisClient.hdel(contextMapKey, fileInfo.hash);
                    }
                }
                
                // Always invalidate cache immediately so list operations reflect changes
                invalidateFileCollectionCache(contextId, contextKey);

                // Delete files from cloud storage ASYNC (only for files with no remaining references)
                // IMPORTANT: Don't delete permanent files from cloud storage - they should persist
                (async () => {
                    for (const fileInfo of filesToFullyDelete) {
                        // Skip deletion if file is marked as permanent
                        if (fileInfo.permanent) {
                            logger.info(`Skipping cloud deletion for permanent file: ${fileInfo.displayFilename} (hash: ${fileInfo.hash})`);
                            continue;
                        }
                        
                        try {
                            logger.info(`Deleting file from cloud storage (no remaining references): ${fileInfo.displayFilename} (hash: ${fileInfo.hash})`);
                            await deleteFileByHash(fileInfo.hash, resolver, contextId);
                        } catch (error) {
                            logger.warn(`Failed to delete file ${fileInfo.displayFilename} (hash: ${fileInfo.hash}) from cloud storage: ${error?.message || String(error)}`);
                        }
                    }
                })().catch(err => logger.error(`Async cloud deletion error: ${err}`));

                const removedCount = filesToProcess.length;
                const removedFiles = filesToProcess.map(f => ({
                    id: f.id,
                    displayFilename: f.displayFilename,
                    hash: f.hash,
                    fullyDeleted: filesToFullyDelete.some(fd => fd.hash === f.hash)
                }));

                // Get remaining files count after deletion
                const remainingCollection = await loadFileCollection({ contextId, contextKey, default: true }, { useCache: false });
                const remainingCount = remainingCollection.length;

                // Build result message
                let message = `${removedCount} file(s) removed from collection`;
                
                if (notFoundFiles.length > 0) {
                    message += `. Could not find: ${notFoundFiles.join(', ')}`;
                }
                
                message += " (Cloud storage cleanup started in background)";

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "remove" });
                return JSON.stringify({
                    success: true,
                    removedCount: removedCount,
                    remainingFiles: remainingCount,
                    message: message,
                    removedFiles: removedFiles,
                    notFoundFiles: notFoundFiles.length > 0 ? notFoundFiles : undefined
                });

            } else {
                // List collection (read-only, no locking needed)
                const { tags: filterTags = [], sortBy = 'date', limit = 50, includeAllChats = false } = args;
                
                // Determine which chatId to use for filtering (null if includeAllChats is true)
                const filterChatId = includeAllChats ? null : chatId;
                
                // Use loadFileCollection to include files from all agentContext contexts
                // Filter by chatId if includeAllChats is false and chatId is available
                const collection = await loadFileCollection(
                    args.agentContext, 
                    { chatIds: filterChatId ? [filterChatId] : null }
                );
                let results = collection;

                // Filter by tags if provided
                if (filterTags.length > 0) {
                    results = results.filter(file =>
                        Array.isArray(file.tags) && filterTags.every(filterTag =>
                            file.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())
                        )
                    );
                }

                // Sort results
                if (sortBy === 'date') {
                    results.sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate));
                } else if (sortBy === 'filename') {
                    results.sort((a, b) => {
                        // Fallback to filename if displayFilename is not set
                        const aDisplayFilename = a.displayFilename || a.filename || '';
                        const bDisplayFilename = b.displayFilename || b.filename || '';
                        return aDisplayFilename.localeCompare(bDisplayFilename);
                    });
                }

                // Limit results
                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "list" });
                
                // Build helpful message
                let message;
                if (results.length === 0) {
                    const suggestions = [];
                    if (chatId && !includeAllChats) {
                        suggestions.push('try includeAllChats=true to see files from all chats');
                    }
                    if (filterTags.length > 0) {
                        suggestions.push('remove tag filters to see more files');
                    }
                    message = suggestions.length > 0 
                        ? `No files in collection. Suggestions: ${suggestions.join('; ')}.`
                        : 'No files in collection.';
                } else {
                    message = (results.length === collection.length) ? `Showing all ${results.length} file(s). These are ALL of the files that you can access. Use the hash or displayFilename to reference files in other tools.` : `Showing ${results.length} of ${collection.length} file(s). Use the hash or displayFilename to reference files in other tools.`;
                }
                
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    totalFiles: collection.length,
                    message,
                    files: results.map(f => ({
                        id: f.id,
                        hash: f.hash || null,
                        displayFilename: f.displayFilename || f.filename || null,
                        url: f.url,
                        gcs: f.gcs || null,
                        tags: f.tags,
                        notes: f.notes,
                        addedDate: f.addedDate,
                        lastAccessed: f.lastAccessed
                    }))
                });
            }

        } catch (e) {
            logger.error(`Error in file collection operation: ${e.message}`);
            
            const errorResult = {
                success: false,
                error: e.message || "Unknown error occurred"
            };

            resolver.tool = JSON.stringify({ toolUsed: "FileCollection" });
            return JSON.stringify(errorResult);
        }
    }
};

