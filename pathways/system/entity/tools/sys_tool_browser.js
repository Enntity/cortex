// sys_tool_browser.js
// Tool pathway that handles web page content scraping functionality
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        enabled: false,
        icon: "🌍",
        function: {
            name: "FetchWebPageContent",
            description: "This tool allows you to fetch and extract the text content and a screenshot if requested from any webpage. Use this when you need to analyze or understand the content of a specific webpage.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The complete URL of the webpage to fetch and analyze"
                    },
                    takeScreenshot: {
                        type: "boolean",
                        description: "Whether to include a screenshot of the webpage in the response - slower, but can be helpful for digging deeper if the text content is not enough to answer the question"
                    },
                    userMessage: {
                        type: "string",
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ["url", "userMessage"]
            }
        }
    },

    summarize: (content) => {
        try {
            const parsed = JSON.parse(content);
            if (parsed._type === 'SearchResponse' && Array.isArray(parsed.value)) {
                const compressed = parsed.value.map(r => ({
                    searchResultId: r.searchResultId,
                    title: r.title, url: r.url,
                    content: (r.content || '').substring(0, 500) + (r.content?.length > 500 ? '...' : '')
                }));
                return JSON.stringify({ _type: 'SearchResponse', value: compressed, _compressed: true });
            }
        } catch { /* not JSON */ }
        return content.substring(0, 500) + '\n\n[Compressed — full content will be restored for final synthesis]';
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Check if browser service URL is available
        const browserServiceUrl = config.get('browserServiceUrl');
        if (!browserServiceUrl) {
            throw new Error("Browser service is not available - missing CORTEX_BROWSER_URL configuration");
        }

        try {
            // Construct the full URL for the browser service
            const scrapeUrl = `${browserServiceUrl}/api/scrape?url=${encodeURIComponent(args.url)}`;
            
            // Call the browser service
            const response = await fetch(scrapeUrl);
            if (!response.ok) {
                throw new Error(`Browser service returned error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            
            // Create a result object with the scraped content
            const result = {
                searchResultId: getSearchResultId(),
                title: "Webpage Content",
                url: data.url,
                content: data.text,
                screenshot: args.takeScreenshot ? data.screenshot_base64 : undefined
            };

            resolver.tool = JSON.stringify({ toolUsed: "WebPageContent" });
            return JSON.stringify({ _type: "SearchResponse", value: [result] });
        } catch (e) {
            logger.error(`Error in browser tool: ${e}`);
            throw e;
        }
    }
}; 