// sys_tool_create_applet.js
// Entity tool that generates inline interactive applets for UI/interactive experiences

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';
import { uploadFileToCloud, addFileToCollection, getMimeTypeFromFilename } from '../../../../lib/fileUtils.js';

// Helper function to extract HTML content from code block response
function extractAppletContent(response) {
    const responseStr = String(response || '').trim();
    
    // Try to extract content from code block
    const codeBlockMatch = responseStr.match(/```(?:applet|html-applet)(?:\s+title="[^"]*")?(?:\s+height="[^"]*")?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }
    
    // If no code block, try to find HTML content
    if (responseStr.includes('<!DOCTYPE') || responseStr.includes('<html>') || responseStr.includes('<div')) {
        return responseStr;
    }
    
    // Fallback: return as-is
    return responseStr;
}

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        contextKey: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'claude-4-5-sonnet-vertex',
    reasoningEffort: 'high',
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "📱",
        function: {
            name: "CreateApplet",
            description: "Generate an inline interactive applet (a small interactive UI component) when the user is asking for a UI, interactive experience, widget, tool, calculator, form, game, visualization, or any interactive HTML/JavaScript component. This creates an embedded applet that renders directly in the chat interface. Use this tool when the user wants to interact with something, visualize data interactively, play with controls, or use a tool/widget.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions describing what the applet should do, what UI elements it needs, what functionality it should have, and any specific design requirements. Be specific about the interactive features, inputs, outputs, and user experience."
                    },
                    title: {
                        type: "string",
                        description: "Optional: A descriptive title for the applet (e.g., 'Calculator', 'Color Picker', 'Data Visualizer'). If not provided, a title will be generated based on the functionality."
                    },
                    height: {
                        type: "string",
                        description: "Optional: Height in pixels for the applet (e.g., '400', '500'). Default is 300 if not specified. Use larger heights for complex interfaces."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    }],
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        try {
            const pathwayResolver = resolver;
            const { contextId, contextKey, chatId } = args;
            
            // Build the system prompt - generate just the HTML content (no code block markers)
            const systemPrompt = `You are a UI/UX expert assistant. Your task is to create inline interactive applets that render directly in chat interfaces.

Each applet is a single page application that should be responsive to the screen size, accessible, secure, and performant.

CODING GUIDELINES:
- Return ONLY the complete HTML code for the applet - do NOT include code block markers (\`\`\`applet) or any other formatting
- The HTML should be a complete, self-contained document ready to render
- CRITICAL: Always implement actual functionality - never use placeholders, mock data, or TODO comments. Every UI component should be fully functional and ready for production use. Where possible, use the internal REST endpoints provided below to accomplish tasks instead of using a third party service.

HTML STRUCTURE:
- Start with <!DOCTYPE html> and include a complete <html> document
- Include <head> with <style> tag for CSS
- Include <body> with your HTML content
- Include <script> tags for JavaScript (inline, not external)

AVAILABLE ENDPOINTS:

Applets run in OutputSandbox with access to REST endpoints for prompts, data persistence, and file management. These endpoints are available through environment variables or container configuration. Use these endpoints instead of third-party services when possible.

1. PROMPT ENDPOINT (if available):
   Applets can execute prompts through a REST endpoint. The endpoint supports both direct prompts and prompts by ID, and can handle multimodal content including files and images.
   
   The endpoint expects:
   - promptId: (REQUIRED if available) The ID of the prompt to execute
   - prompt: (optional) The text to be processed. Only use this if promptId is not available.
   - systemPrompt: (optional) Specific instructions for the LLM
   - files: (optional) Array of file objects to include with the request
   - chatHistory: (optional) Pre-built array of chat messages (advanced use case)
   
   The endpoint returns a JSON response with:
   - output: The LLM's response text
   - citations: Array of citations if any were generated
   
   Example usage:
   \`\`\`javascript
   async function executePrompt(options) {
       const response = await fetch(window.PROMPT_ENDPOINT || '/api/prompt', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
               promptId: options.promptId,
               prompt: options.prompt,
               systemPrompt: options.systemPrompt,
               files: options.files
           })
       });
       const data = await response.json();
       return {
           output: data.output,
           citations: data.citations,
       };
   }
   \`\`\`
   
   Output from the prompt endpoint should be rendered in a <pre class="llm-output"> tag to handle markdown and citations properly.

2. DATA PERSISTENCE ENDPOINT (if available):
   Applets can save and retrieve data using REST endpoints:
   
   SAVE DATA (PUT): window.DATA_ENDPOINT || '/api/data'
   - Method: PUT
   - Headers: Content-Type: application/json
   - Body: { "key": "string", "value": "any" }
   - Returns: { "success": true, "data": { "key": "value", ... } }
   
   RETRIEVE DATA (GET): window.DATA_ENDPOINT || '/api/data'
   - Method: GET
   - Returns: { "data": { "key": "value", ... } }
   
   Example usage:
   \`\`\`javascript
   async function saveData(key, value) {
       const response = await fetch(window.DATA_ENDPOINT || '/api/data', {
           method: 'PUT',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ key, value })
       });
       const result = await response.json();
       return result.success ? result.data : null;
   }
   
   async function loadData() {
       const response = await fetch(window.DATA_ENDPOINT || '/api/data');
       const result = await response.json();
       return result.data || {};
   }
   \`\`\`

3. FILE MANAGEMENT ENDPOINT (if available):
   Applets can upload, retrieve, and manage files:
   
   UPLOAD FILE (POST): window.FILE_ENDPOINT || '/api/files'
   - Method: POST
   - Headers: Content-Type: multipart/form-data
   - Body: FormData with 'file' field
   - Returns: File object with metadata
   
   RETRIEVE FILES (GET): window.FILE_ENDPOINT || '/api/files'
   - Method: GET
   - Returns: { "files": [...] }
   
   READ FILE CONTENT (GET): (window.FILE_ENDPOINT || '/api/files') + '/' + fileId + '/content'
   - Method: GET
   - Returns: The file content as a binary stream (Blob/ArrayBuffer)
   
   DELETE FILE (DELETE): window.FILE_ENDPOINT || '/api/files' + '?filename=' + filename
   - Method: DELETE
   - Returns: { "success": true, "files": [...] }

IMPORTANT DATA PERSISTENCE GUIDELINES:
1. Always implement data loading on page initialization
2. Save data automatically when users make changes (auto-save)
3. Provide visual feedback when data is being saved or loaded
4. Handle errors gracefully with user-friendly messages
5. Use descriptive keys for data storage (e.g., "userPreferences", "formData", "settings")
6. Consider data structure - store complex objects as JSON strings if needed
7. Implement data validation before saving
8. Provide clear save/load status indicators
9. Use localStorage as a fallback for offline functionality when appropriate
10. Implement data export/import features for user convenience

STYLING GUIDELINES:
- Use clean, semantic HTML with descriptive class names
- Include a <style> tag with your CSS rules
- Style guidelines:
  - Use TailwindCSS imported from <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  - Use rounded-md for rounded corners
  - Use sky color scheme as default (sky-500, sky-600, sky-700)
  - Use gray-300 for borders
  - Use proper spacing with p-4, m-2, gap-3, etc.
  - Use flex and grid layouts for responsive design
  - Use shadow-md for subtle shadows
  - Use hover:bg-sky-50 for hover states
  - Use focus:ring-2 focus:ring-sky-500 for focus states
  
- Use Lucide icons:
  - Use the latest version of Lucide icons
  - e.g. for house, <img src="/api/icons/house" />, for bar-chart-2, <img src="/api/icons/bar-chart-2" />
  - Use w-5 h-5 classes for consistent icon sizing
  - Use inline-flex items-center gap-2 for icon + text combinations
  
- Form styling guidelines:
  - Use <input> with classes: "w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
  - Use <select> with classes: "w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
  - Use <button> with classes: "px-4 py-2 bg-sky-500 text-white rounded-md hover:bg-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2"
  - Use <textarea> with classes: "w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 resize-vertical"
  
- Layout guidelines:
  - Use container classes: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"
  - Use card styling: "bg-white rounded-lg shadow-md border border-gray-200 p-6"
  - Use responsive grid: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
  - Use flexbox for alignment: "flex items-center justify-between"
  
- Typography guidelines:
  - Use proper heading hierarchy (h1, h2, h3, etc.)
  - Use text-lg for headings, text-base for body, text-sm for captions
  - Use font-medium for semi-bold text
  - Use text-gray-600 for secondary text
  
- Interactive elements:
  - Always include proper hover and focus states
  - Use transition-all duration-200 for smooth animations
  - Ensure proper contrast ratios for accessibility
  - Include proper ARIA labels and roles
  
- Suggested color scheme:
  - Primary: sky-500 (#0ea5e9)
  - Secondary: gray-500 (#6b7280)
  - Success: green-500 (#10b981)
  - Warning: yellow-500 (#f59e0b)
  - Error: red-500 (#ef4444)
  - Background: gray-50 (#f9fafb)
  - Surface: white (#ffffff)

- Light and dark mode:
  - Support light and dark mode in all components with standard TailwindCSS classes
  - Invert icons as needed to ensure they are visible in both light and dark mode
  - The container handles theme automatically

FUNCTIONALITY REQUIREMENTS:
- Implement real data handling and processing
- Use actual API calls when endpoints are available
- Implement proper error handling and loading states
- Add form validation with real-time feedback
- Implement proper state management for dynamic content
- Use real event handlers for all interactive elements
- Implement proper data persistence where applicable
- Add proper accessibility features (ARIA labels, keyboard navigation)
- Implement responsive design with actual breakpoints
- Use real authentication/authorization when required
- Implement proper data formatting and display
- Add real-time updates where appropriate
- Implement proper search and filtering functionality
- Add export/import capabilities when needed
- Implement proper file upload/download functionality
- Add real-time collaboration features when applicable
- Implement proper caching strategies
- Add proper logging and monitoring hooks
- Implement proper security measures (input sanitization, CSRF protection)

IMPORTANT:
- Return ONLY the HTML code - no code blocks, no markdown, no explanation
- Make sure the HTML is complete and self-contained
- Include all necessary JavaScript inline in <script> tags
- Include all necessary CSS inline in <style> tags
- The applet runs in a sandboxed iframe, so it needs to be fully self-contained`;

            // Build user message with instructions
            let userMessage = args.detailedInstructions || '';
            
            // Add title and height if provided (these will be stored as metadata, not in the HTML)
            if (args.title) {
                userMessage += `\n\nApplet title: ${args.title}`;
            }
            if (args.height) {
                userMessage += `\n\nApplet height: ${args.height} pixels`;
            }
            
            // Set up the prompt dynamically
            pathwayResolver.pathwayPrompt = [
                new Prompt({ messages: [
                    {"role": "system", "content": systemPrompt},
                    {"role": "user", "content": userMessage}
                ]})
            ];
            
            // Execute the prompt to generate the applet HTML code
            const htmlResponse = await runAllPrompts({ ...args, stream: false });
            
            // Extract the HTML content from the response
            const htmlContent = extractAppletContent(htmlResponse);
            
            if (!htmlContent || htmlContent.trim().length === 0) {
                throw new Error('Failed to generate applet HTML content');
            }
            
            // Generate filename with timestamp
            const timestamp = Date.now();
            const appletTitle = (args.title || 'applet').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const filename = `${appletTitle}-${timestamp}.html`;
            
            // Convert HTML content to buffer
            const fileBuffer = Buffer.from(htmlContent, 'utf8');
            
            // Determine MIME type
            const mimeType = getMimeTypeFromFilename(filename, 'text/html');
            
            // Upload file to cloud storage
            const uploadResult = await uploadFileToCloud(
                fileBuffer,
                `${mimeType}; charset=utf-8`,
                filename,
                pathwayResolver,
                contextId
            );
            
            if (!uploadResult || !uploadResult.url) {
                throw new Error('Failed to upload applet file to cloud storage');
            }
            
            // Add to file collection if contextId is provided
            let fileEntry = null;
            const tags = ['applet', 'html', 'interactive'];
            const notes = `Interactive applet: ${args.title || 'Generated applet'}. ${args.detailedInstructions ? args.detailedInstructions.substring(0, 200) : ''}`;
            
            if (contextId) {
                try {
                    fileEntry = await addFileToCollection(
                        contextId,
                        contextKey || null,
                        uploadResult.url,
                        uploadResult.gcs || null,
                        filename,
                        tags,
                        notes,
                        uploadResult.hash || null,
                        null, // fileUrl - not needed since we already uploaded
                        pathwayResolver,
                        true, // permanent => retention=permanent
                        chatId || null
                    );
                } catch (collectionError) {
                    // Log but don't fail - file collection is optional
                    logger.warn(`Failed to add applet file to collection: ${collectionError.message}`);
                }
            }
            
            // Build the applet code block with URL reference (Format 2 from APPLET_SPEC.md)
            const appletAttributes = [];
            if (args.title) {
                appletAttributes.push(`title="${args.title}"`);
            }
            if (args.height) {
                appletAttributes.push(`height="${args.height}"`);
            }
            appletAttributes.push(`url="${uploadResult.url}"`);
            
            const appletCodeBlock = `\`\`\`applet ${appletAttributes.join(' ')}
\`\`\``;
            
            const result = {
                success: true,
                filename: filename,
                url: uploadResult.url,
                gcs: uploadResult.gcs || null,
                hash: uploadResult.hash || null,
                fileId: fileEntry?.id || null,
                size: fileBuffer.length,
                appletCodeBlock: appletCodeBlock,
                message: `Applet generated successfully. The applet code block is ready to be included in your response.`
            };
            
            pathwayResolver.tool = JSON.stringify({ toolUsed: "CreateApplet" });
            
            // Return the applet code block directly - the agent should include this in their response
            return appletCodeBlock;
            
        } catch (e) {
            logger.error(`Error in CreateApplet tool: ${e}`);
            return JSON.stringify({
                error: true,
                message: `Applet generation failed: ${e.message}`,
                toolName: 'CreateApplet'
            });
        }
    }
};

