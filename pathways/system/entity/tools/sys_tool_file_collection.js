// sys_tool_file_collection.js
// Tool pathway that manages user file collections via GCS (list, search, add, remove).
// GCS is the source of truth — files are just files in a bucket, no hashing or metadata.
import logger from '../../../../lib/logger.js';
import { uploadFileToCloud, findFileInCollection, deleteFileByName, listFilesForContext } from '../../../../lib/fileUtils.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: [
        {
            type: "function",
            icon: "📁",
            toolCost: 1,
            function: {
                name: "FileCollection",
                description: `Manage your file collection. Operations are inferred from parameters:
• ADD: Provide fileUrl (to upload) + filename
• SEARCH: Provide query to search by filename
• LIST: No query/fileUrl/fileIds → lists all files
• REMOVE: Provide fileIds array to delete files by filename`,
                parameters: {
                    type: "object",
                    properties: {
                        fileUrl: {
                            type: "string",
                            description: "ADD: URL of a file to upload to cloud storage"
                        },
                        filename: {
                            type: "string",
                            description: "ADD: Filename for the file being added"
                        },
                        query: {
                            type: "string",
                            description: "SEARCH: Search query - searches by filename (case-insensitive)"
                        },
                        fileIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "REMOVE: Array of filenames to delete"
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
                        userMessage: {
                            type: "string",
                            description: 'Brief message to display while this action runs'
                        }
                    },
                    required: ["userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { contextId } = args;
        if (!contextId) {
            throw new Error("contextId is required.");
        }

        const isAdd = args.fileUrl !== undefined;
        const isSearch = args.query !== undefined;
        const isRemove = args.fileIds !== undefined || args.fileId !== undefined;

        try {
            if (isAdd) {
                const { fileUrl, filename } = args;
                if (!filename) throw new Error("filename is required");
                if (!fileUrl) throw new Error("fileUrl is required");

                const result = await uploadFileToCloud(fileUrl, null, filename, resolver, contextId, args.chatId || null);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "add" });
                return JSON.stringify({
                    success: true,
                    filename: result.filename || filename,
                    blobPath: result.blobPath || null,
                    url: result.url,
                    message: `File "${filename}" uploaded successfully`
                });

            } else if (isSearch) {
                const { query, limit = 20 } = args;
                if (!query || typeof query !== 'string') throw new Error("query is required");

                const files = await listFilesForContext(contextId, { fileScope: 'all' });
                const queryLower = query.toLowerCase().replace(/[-_\s]+/g, ' ').trim();

                let results = files.filter(f => {
                    const name = (f.displayFilename || f.filename || '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();
                    return name.includes(queryLower);
                }).slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "search" });
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    message: results.length === 0
                        ? `No files found matching "${query}".`
                        : `Found ${results.length} file(s) matching "${query}".`,
                    files: results.map(f => ({
                        filename: f.displayFilename || f.filename,
                        blobPath: f.blobPath || null,
                        url: f.url,
                        size: f.size,
                        contentType: f.contentType,
                        lastModified: f.lastModified
                    }))
                });

            } else if (isRemove) {
                const { fileIds, fileId } = args;
                const targets = Array.isArray(fileIds) ? fileIds : (fileId ? [fileId] : []);
                if (targets.length === 0) throw new Error("fileIds array is required");

                const files = await listFilesForContext(contextId, { fileScope: 'all' });
                const removed = [];
                const notFound = [];

                for (const target of targets) {
                    const found = findFileInCollection(target, files);
                    if (found?.filename) {
                        try {
                            await deleteFileByName(found.filename, resolver, contextId);
                            removed.push({ filename: found.displayFilename || found.filename });
                        } catch (e) {
                            logger.warn(`Failed to delete file ${found.filename}: ${e.message}`);
                            removed.push({ filename: found.displayFilename || found.filename, error: e.message });
                        }
                    } else {
                        notFound.push(target);
                    }
                }

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "remove" });
                return JSON.stringify({
                    success: true,
                    removedCount: removed.length,
                    message: `${removed.length} file(s) removed.${notFound.length ? ` Not found: ${notFound.join(', ')}` : ''}`,
                    removedFiles: removed,
                    notFoundFiles: notFound.length > 0 ? notFound : undefined
                });

            } else {
                const { sortBy = 'date', limit = 50 } = args;
                const files = await listFilesForContext(contextId, { fileScope: 'all' });
                let results = [...files];

                if (sortBy === 'filename') {
                    results.sort((a, b) => (a.displayFilename || a.filename || '').localeCompare(b.displayFilename || b.filename || ''));
                } else {
                    results.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
                }
                results = results.slice(0, limit);

                resolver.tool = JSON.stringify({ toolUsed: "FileCollection", action: "list" });
                return JSON.stringify({
                    success: true,
                    count: results.length,
                    totalFiles: files.length,
                    message: results.length === 0
                        ? 'No files in collection.'
                        : `Showing ${results.length} of ${files.length} file(s). Use filename to reference files.`,
                    files: results.map(f => ({
                        filename: f.displayFilename || f.filename,
                        blobPath: f.blobPath || null,
                        url: f.url,
                        size: f.size,
                        contentType: f.contentType,
                        lastModified: f.lastModified
                    }))
                });
            }

        } catch (e) {
            logger.error(`Error in file collection operation: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "FileCollection" });
            return JSON.stringify({ success: false, error: e.message || "Unknown error occurred" });
        }
    }
};
