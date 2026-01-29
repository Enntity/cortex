// sys_tool_push_notification.js
// Tool pathway that allows entities to send push notifications to users
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: { 
        type: "function",
        icon: "🔔",
        function: {
            name: "SendPushNotification",
            description: "Send a push notification to the user. Use this when you want to proactively reach out to the user with important updates, reminders, or messages when they may not be actively engaged in conversation. The notification will appear on their device if they have notifications enabled.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "The notification title. Keep it short and attention-grabbing (ideally under 50 characters)."
                    },
                    body: {
                        type: "string",
                        description: "The notification body text. Keep it concise and actionable (ideally under 150 characters)."
                    },
                    url: {
                        type: "string",
                        description: "Optional: A URL path to open when the user taps the notification (e.g., '/chat/abc123'). If not provided, defaults to opening the current conversation."
                    },
                    tag: {
                        type: "string",
                        description: "Optional: A tag for notification deduplication. Notifications with the same tag will replace previous ones instead of stacking. Useful for updates to the same topic (e.g., 'reminder-workout', 'daily-checkin')."
                    },
                    userMessage: {
                        type: "string",
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ["title", "body", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { title, body, url, tag, contextId } = args;
        
        // Validate required parameters
        if (!title || typeof title !== 'string' || title.trim() === '') {
            return JSON.stringify({
                success: false,
                error: "Title is required and must be a non-empty string"
            });
        }

        if (!body || typeof body !== 'string' || body.trim() === '') {
            return JSON.stringify({
                success: false,
                error: "Body is required and must be a non-empty string"
            });
        }

        // Get the user ID from context
        const userId = contextId;
        if (!userId) {
            return JSON.stringify({
                success: false,
                error: "Unable to determine user ID. Push notification cannot be sent without a target user."
            });
        }

        // Get API configuration from environment
        const env = config.getEnv();
        const apiBaseUrl = env["ENNTITY_API_BASE_URL"];
        const apiSharedKey = env["ENNTITY_API_SHARED_KEY"];

        if (!apiBaseUrl) {
            logger.error('Push notification failed - ENNTITY_API_BASE_URL not configured');
            return JSON.stringify({
                success: false,
                error: "Push notification service is not configured (missing API base URL)"
            });
        }

        if (!apiSharedKey) {
            logger.error('Push notification failed - ENNTITY_API_SHARED_KEY not configured');
            return JSON.stringify({
                success: false,
                error: "Push notification service is not configured (missing API key)"
            });
        }

        try {
            // Construct the push endpoint URL
            const pushUrl = `${apiBaseUrl.replace(/\/$/, '')}/push`;

            // Build the request payload
            const payload = {
                userId: userId,
                title: title.trim(),
                body: body.trim()
            };

            // Add optional URL if provided
            if (url && typeof url === 'string' && url.trim() !== '') {
                payload.url = url.trim();
            }

            // Add optional tag for deduplication if provided
            if (tag && typeof tag === 'string' && tag.trim() !== '') {
                payload.tag = tag.trim();
            }

            logger.info(`Sending push notification to user ${userId}: "${title}"`);

            // Make the API request
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

            const response = await fetch(pushUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-enntity-push-key': apiSharedKey
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Parse the response
            let responseData;
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
            }

            // Check for success
            if (response.ok) {
                logger.info(`Push notification sent successfully to user ${userId}`);
                
                if (resolver) {
                    resolver.tool = JSON.stringify({ toolUsed: "SendPushNotification" });
                }

                return JSON.stringify({
                    success: true,
                    message: `Push notification sent successfully to user`,
                    title: title.trim(),
                    body: body.trim()
                });
            } else {
                // Handle error response
                const errorMessage = typeof responseData === 'object' 
                    ? (responseData.error || responseData.message || JSON.stringify(responseData))
                    : responseData;
                
                logger.error(`Push notification failed (HTTP ${response.status}): ${errorMessage}`);
                
                return JSON.stringify({
                    success: false,
                    error: `Failed to send push notification: ${errorMessage}`,
                    statusCode: response.status
                });
            }

        } catch (e) {
            if (e.name === 'AbortError') {
                logger.error('Push notification request timed out');
                return JSON.stringify({
                    success: false,
                    error: "Push notification request timed out"
                });
            }

            logger.error(`Error sending push notification: ${e.message || e}`);
            return JSON.stringify({
                success: false,
                error: `Failed to send push notification: ${e.message || String(e)}`
            });
        }
    }
};
