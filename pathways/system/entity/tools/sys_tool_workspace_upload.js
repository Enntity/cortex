// sys_tool_workspace_upload.js
// Upload a file from workspace container to cloud storage
import logger from '../../../../lib/logger.js';
import { uploadFileToCloud, addFileToCollection } from '../../../../lib/fileUtils.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 120,
    toolDefinition: {
        type: "function",
        icon: "📤",
        function: {
            name: "WorkspaceUpload",
            description: "Upload a file from your workspace container to cloud storage, making it available in your file collection. Use this to share workspace files with the user or persist artifacts. The file is read from the workspace container and uploaded to cloud storage.",
            parameters: {
                type: "object",
                properties: {
                    workspacePath: {
                        type: "string",
                        description: "Absolute path to the file in the workspace container (e.g. /workspace/output/report.pdf)"
                    },
                    filename: {
                        type: "string",
                        description: "Display name for the file in the collection. If not provided, uses the filename from the path."
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tags for organizing the file in the collection"
                    },
                    notes: {
                        type: "string",
                        description: "Optional description or notes about the file"
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["workspacePath", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { workspacePath, filename, tags, notes, entityId, contextId, contextKey, chatId } = args;

        try {
            if (!workspacePath || typeof workspacePath !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceUpload" });
                return JSON.stringify({ success: false, error: "workspacePath is required" });
            }

            // Read file from workspace as base64
            const readResult = await workspaceRequest(entityId, '/read', {
                path: workspacePath,
                encoding: 'base64',
            }, { timeoutMs: 60000 });

            if (!readResult.success) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceUpload" });
                return JSON.stringify({ success: false, error: readResult.error || 'Failed to read file from workspace' });
            }

            // Create buffer from base64 content
            const buffer = Buffer.from(readResult.content, 'base64');

            // Determine filename
            const displayName = filename || workspacePath.split('/').pop();

            // Upload to cloud storage
            const uploadResult = await uploadFileToCloud(buffer, null, displayName, resolver, contextId);

            if (!uploadResult || !uploadResult.url) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceUpload" });
                return JSON.stringify({ success: false, error: 'Failed to upload file to cloud storage' });
            }

            // Add to file collection
            const fileEntry = await addFileToCollection(
                contextId,
                contextKey || '',
                uploadResult.url,
                uploadResult.gcs || null,
                displayName,
                tags || [],
                notes || '',
                uploadResult.hash || null,
                null,
                resolver,
                true, // permanent
                chatId || null,
                entityId || null
            );

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceUpload" });
            return JSON.stringify({
                success: true,
                filename: displayName,
                fileId: fileEntry?.id || null,
                url: uploadResult.url,
                hash: uploadResult.hash || null,
            });
        } catch (e) {
            logger.error(`WorkspaceUpload error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceUpload" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
