import GeminiChatPlugin from './geminiChatPlugin.js';
import mime from 'mime-types';

class GeminiVisionPlugin extends GeminiChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
    }
    
    // Override the convertMessagesToGemini method to handle multimodal vision messages
    // This function can operate on messages in Gemini native format or in OpenAI's format
    // It will convert the messages to the Gemini format
    convertMessagesToGemini(messages) {
        let modifiedMessages = [];
        let lastAuthor = '';
    
        // Check if the messages are already in the Gemini format
        if (messages[0] && Object.prototype.hasOwnProperty.call(messages[0], 'parts')) {
            modifiedMessages = messages;
        } else {
            messages.forEach(message => {
                let role = message.role;
                const { author, content } = message;

                // Convert content to Gemini format, trying to maintain compatibility
                const convertPartToGemini = (inputPart) => {
                    try {
                        const part = typeof inputPart === 'string' ? JSON.parse(inputPart) : inputPart;
                        const {type, text, image_url, url} = part;
                        let fileUrl = image_url?.url || url;

                        if (typeof part === 'string') {
                            return { text: text };
                        } else if (type === 'text') {
                            return { text: text };
                        } else if (type === 'image_url') {
                            if (!fileUrl) {
                                return null;
                            }
                            if (fileUrl.startsWith('gs://')) {
                                return {
                                    fileData: {
                                        mimeType: mime.lookup(fileUrl) || 'image/jpeg',
                                        fileUri: fileUrl
                                    }
                                };
                            } else if (fileUrl.includes('base64,')) {
                                const base64Data = fileUrl.split('base64,')[1];
                                if (!base64Data) {
                                    return null;
                                }
                                const mimeMatch = fileUrl.match(/data:([^;]+);base64,/);
                                const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                                return {
                                    inlineData: {
                                        mimeType,
                                        data: base64Data
                                    }
                                };
                            } else if (fileUrl.includes('youtube.com/') || fileUrl.includes('youtu.be/')) {
                                return {
                                    fileData: {
                                        mimeType: 'video/youtube',
                                        fileUri: fileUrl
                                    }
                                };
                            } else if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                                return {
                                    fileData: {
                                        mimeType: mime.lookup(fileUrl) || 'image/jpeg',
                                        fileUri: fileUrl
                                    }
                                };
                            } else {
                                return null;
                            }
                        }
                    } catch (e) {
                        // this space intentionally left blank
                    }
                    return inputPart ? { text: inputPart } : null;
                };

                const addPartToMessages = (geminiPart) => {
                    if (!geminiPart) { return; }
                    // Gemini requires alternating user: and model: messages
                    if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                        modifiedMessages[modifiedMessages.length - 1].parts.push(geminiPart);
                    }
                    // Gemini only supports user: and model: roles
                    else if (role === 'user' || role === 'assistant' || author) {
                        modifiedMessages.push({
                            role: author || role,
                            parts: [geminiPart],
                        });
                        lastAuthor = author || role;
                    }
                };

                // Right now Gemini API has no direct translation for system messages,
                // so we insert them as parts of the first user: role message
                if (role === 'system') {
                    role = 'user';
                    addPartToMessages(convertPartToGemini(content));
                    return;
                }

                // Content can either be in the "vision" format (array) or in the "chat" format (string)
                if (Array.isArray(content)) {
                    content.forEach(part => {
                        addPartToMessages(convertPartToGemini(part));
                    });
                } 
                else {
                    addPartToMessages(convertPartToGemini(content));
                }
            });
        }
    
        // Gemini requires an odd number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }
    
        return {
            modifiedMessages,
        };
    }

}

export default GeminiVisionPlugin;
