import { ModelExecutor } from './modelExecutor.js';
import { modelEndpoints } from '../lib/requestExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { encode } from '../lib/encodeCache.js';
import { getFirstNToken, getLastNToken, getSemanticChunks } from './chunker.js';
import { PathwayResponseParser } from './pathwayResponseParser.js';
import { Prompt } from './prompt.js';
import { getv, setv } from '../lib/keyValueStorageClient.js';
import { getvWithDoubleDecryption, setvWithDoubleEncryption } from '../lib/keyValueStorageClient.js';
import { requestState } from './requestState.js';
import { addCitationsToResolver } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';
import { publishRequestProgress } from '../lib/redisSubscription.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import { createParser } from 'eventsource-parser';
import CortexResponse from '../lib/cortexResponse.js';
// Continuity Memory Architecture (parallel system)
import { getContinuityMemoryService } from '../lib/continuity/index.js';
import { ContextBuilder } from '../lib/continuity/synthesis/ContextBuilder.js';
// Shared context key registry for user-level encryption
import { registerContextKey } from '../lib/contextKeyRegistry.js';

const modelTypesExcludedFromProgressUpdates = ['OPENAI-DALLE2', 'OPENAI-DALLE3'];

// Continuity context uses stale-while-revalidate caching in Redis:
// - Any cached context is used immediately (even if old)
// - Fresh time context is added on each request
// - Background refresh updates cache for next request
// - Only first-ever request for an entity/user blocks on cold storage

class PathwayResolver {
    // Optional endpoints override parameter is for testing purposes
    constructor({ config, pathway, args, endpoints }) {
        this.endpoints = endpoints || modelEndpoints;
        this.config = config;
        this.pathway = pathway;
        this.args = args;
        this.useInputChunking = pathway.useInputChunking;
        this.chunkMaxTokenLength = 0;
        this.warnings = [];
        this.errors = [];
        this.requestId = uuidv4();
        this.rootRequestId = null;
        this.responseParser = new PathwayResponseParser(pathway);
        this.pathwayResultData = {};
        this.modelName = [
            pathway.model,
            args?.model,
            pathway.inputParameters?.model,
            config.get('defaultModelName')
            ].find(modelName => modelName && Object.prototype.hasOwnProperty.call(this.endpoints, modelName));
        this.model = this.endpoints[this.modelName];

        if (!this.model) {
            throw new Error(`Model ${this.modelName} not found in config`);
        }

        const specifiedModelName = pathway.model || args?.model || pathway.inputParameters?.model;

        if (this.modelName !== (specifiedModelName)) {
            if (specifiedModelName) {
                this.logWarning(`Specified model ${specifiedModelName} not found in config, using ${this.modelName} instead.`);
            } else {
                this.logWarning(`No model specified in the pathway, using ${this.modelName}.`);
            }
        }

        this.previousResult = '';
        this.prompts = [];
        this.modelExecutor = new ModelExecutor(this.pathway, this.model);

        Object.defineProperty(this, 'pathwayPrompt', {
            get() {
                return this.prompts
            },
            set(value) {
                if (!Array.isArray(value)) {
                    value = [value];
                }
                this.prompts = value.map(p => (p instanceof Prompt) ? p : new Prompt({ prompt:p }));
                this.chunkMaxTokenLength = this.getChunkMaxTokenLength();
            }
        });

        // set up initial prompt
        this.pathwayPrompt = pathway.prompt;
    }
    
    // Legacy 'tool' property is now stored in pathwayResultData
    get tool() {      
        // Select fields to serialize for legacy compat, excluding undefined values
        const legacyFields = Object.fromEntries(
            Object.entries({
                hideFromModel: this.pathwayResultData.hideFromModel,    
                toolCallbackName: this.pathwayResultData.toolCallbackName, 
                title: this.pathwayResultData.title,
                search: this.pathwayResultData.search,
                coding: this.pathwayResultData.coding,
                codeRequestId: this.pathwayResultData.codeRequestId,
                toolCallbackId: this.pathwayResultData.toolCallbackId,
                toolUsed: this.pathwayResultData.toolUsed,
                citations: this.pathwayResultData.citations,

            }).filter(([_, value]) => value !== undefined)
        );
        return JSON.stringify(legacyFields);
    }

    set tool(value) {
        // Accepts a JSON string, parses, merges into pathwayResultData
        let parsed;
        try {
            parsed = (typeof value === 'string') ? JSON.parse(value) : value;
            this.pathwayResultData = this.mergeResultData(parsed);
        } catch (e) {
            // Optionally warn: invalid format or merge error
            console.warn('Invalid tool property assignment:', e);
        }
    }

    publishNestedRequestProgress(requestProgress) {

        if (this.rootRequestId) {
            // if this is a nested request, don't end the stream
            if (requestProgress.progress === 1) {
                delete requestProgress.progress;
            }
            publishRequestProgress(requestProgress);
        } else {
            // this is a root request, so we add the pathwayResultData to the info
            // and allow the end stream message to be sent
            if (requestProgress.progress === 1) {
                const infoObject = { ...this.pathwayResultData || {} };
                requestProgress.info = JSON.stringify(infoObject);
                requestProgress.error = this.errors.join(', ') || '';
            }
            publishRequestProgress(requestProgress);
        }

    }

    // This code handles async and streaming responses for either long-running
    // tasks or streaming model responses
    async asyncResolve(args) {
        let responseData = null;
        const requestId = this.rootRequestId || this.requestId;

        try {
            responseData = await this.executePathway(args);
        }
        catch (error) {
            this.errors.push(error.message || error.toString());
            publishRequestProgress({
                requestId,
                progress: 1,
                data: '',
                info: JSON.stringify(this.pathwayResultData || {}),
                error: this.errors.join(', ')
            });
            return;
        }

        if (!responseData) {
            publishRequestProgress({
                requestId,
                progress: 1,
                data: '',
                info: JSON.stringify(this.pathwayResultData || {}),
                error: this.errors.join(', ') || 'No response received'
            });
            return;
        }

        // Handle CortexResponse objects - merge them into pathwayResultData
        if (responseData && typeof responseData === 'object' && responseData.constructor && responseData.constructor.name === 'CortexResponse') {
            this.pathwayResultData = this.mergeResultData(responseData);
        }

        // If the response is a stream, handle it as streaming response
        if (responseData && typeof responseData.on === 'function') {
            await this.handleStream(responseData);
        } else {
            const { completedCount = 1, totalCount = 1 } = requestState[this.requestId];
            requestState[this.requestId].data = responseData;
            
            // some models don't support progress updates
            if (!modelTypesExcludedFromProgressUpdates.includes(this.model.type)) {
                const infoObject = { ...this.pathwayResultData || {} };
                this.publishNestedRequestProgress({
                        requestId,
                        progress: Math.min(completedCount, totalCount) / totalCount,
                        // Clients expect these to be strings
                        data: JSON.stringify(responseData || ''),
                        info: JSON.stringify(infoObject) || '',
                        error: this.errors.join(', ') || ''
                });
            }
        }
    }

    mergeResolver(otherResolver) {
        if (otherResolver) {
            this.previousResult = otherResolver.previousResult ? otherResolver.previousResult : this.previousResult;
            this.warnings = [...this.warnings, ...otherResolver.warnings];
            this.errors = [...this.errors, ...otherResolver.errors];

            // Use the shared mergeResultData method
            this.pathwayResultData = this.mergeResultData(otherResolver.pathwayResultData);
        }
    }

    // Merge pathwayResultData with either another pathwayResultData object or a CortexResponse
    mergeResultData(newData) {
        if (!newData) return this.pathwayResultData;

        const currentData = this.pathwayResultData || {};

        // Handle CortexResponse objects
        if (newData.constructor && newData.constructor.name === 'CortexResponse') {
            const cortexResponse = newData;
            const cortexData = {
                citations: cortexResponse.citations,
                toolCalls: cortexResponse.toolCalls,
                functionCall: cortexResponse.functionCall,
                usage: cortexResponse.usage,
                finishReason: cortexResponse.finishReason,
                artifacts: cortexResponse.artifacts
            };
            newData = cortexData;
        }

        // Create merged result
        const merged = { ...currentData, ...newData };

        // Handle array fields that should be concatenated
        const arrayFields = ['citations', 'toolCalls', 'artifacts'];
        for (const field of arrayFields) {
            const currentArray = currentData[field] || [];
            const newArray = newData[field] || [];
            if (newArray.length > 0) {
                merged[field] = [...currentArray, ...newArray];
            } else if (currentArray.length > 0) {
                merged[field] = currentArray;
            }
        }

        // Handle usage and toolUsed data - convert to arrays with most recent first
        const createArrayFromData = (currentValue, newValue) => {
            if (!currentValue && !newValue) return null;

            const array = [];

            // Add new value first (most recent)
            if (newValue) {
                if (Array.isArray(newValue)) {
                    array.push(...newValue);
                } else {
                    array.push(newValue);
                }
            }

            // Add current value second (older)
            if (currentValue) {
                if (Array.isArray(currentValue)) {
                    array.push(...currentValue);
                } else {
                    array.push(currentValue);
                }
            }

            return array;
        };

        const usageArray = createArrayFromData(currentData.usage, newData.usage);
        if (usageArray) {
            merged.usage = usageArray;
        }

        const toolUsedArray = createArrayFromData(currentData.toolUsed, newData.toolUsed);
        if (toolUsedArray) {
            merged.toolUsed = toolUsedArray;
        }

        return merged;
    }

    async handleStream(response) {
        let streamErrorOccurred = false;
        let streamErrorMessage = null;
        let completionSent = false;
        let receivedSSEData = false; // Track if we actually received SSE events
        let toolCallbackInvoked = false; // Track if a tool callback was invoked (stream close is expected)
        // Accumulate streamed content for continuity memory
        this.streamedContent = '';
        const requestId = this.rootRequestId || this.requestId;

        if (response && typeof response.on === 'function') {
            try {
                const incomingMessage = response;
                let streamEnded = false;

                const onParse = (event) => {
                    let requestProgress = {
                        requestId
                    };

                    logger.debug(`Received event: ${event.type}`);

                    if (event.type === 'event') {
                        logger.debug('Received event!')
                        logger.debug(`id: ${event.id || '<none>'}`)
                        logger.debug(`name: ${event.name || '<none>'}`)
                        logger.debug(`data: ${event.data}`)
                        
                        receivedSSEData = true; // Only mark SSE data when we get actual 'event' type
                        
                        // Check for error events in the stream data
                        try {
                            const eventData = JSON.parse(event.data);
                            if (eventData.error) {
                                streamErrorOccurred = true;
                                streamErrorMessage = eventData.error.message || JSON.stringify(eventData.error);
                                logger.error(`Stream contained error event: ${streamErrorMessage}`);
                            }
                        } catch {
                            // Not JSON or no error field, continue normal processing
                        }
                    } else if (event.type === 'reconnect-interval') {
                        logger.debug(`We should set reconnect interval to ${event.value} milliseconds`)
                    }

                    try {
                        requestProgress = this.modelExecutor.plugin.processStreamEvent(event, requestProgress);
                        // Check if plugin signaled a tool callback was invoked
                        if (requestProgress.toolCallbackInvoked) {
                            toolCallbackInvoked = true;
                        }
                    } catch (error) {
                        streamErrorOccurred = true;
                        streamErrorMessage = error instanceof Error ? error.message : String(error);
                        logger.error(`Stream processing error: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                        incomingMessage.off('data', processStream);
                        return;
                    }

                    try {
                        if (!streamEnded && requestProgress.data) {
                            // Accumulate just the text content for continuity memory
                            // requestProgress.data is the raw JSON - we need to extract delta.content
                            try {
                                const parsed = JSON.parse(requestProgress.data);
                                const textContent = parsed?.choices?.[0]?.delta?.content;
                                if (textContent) {
                                    this.streamedContent += textContent;
                                }
                            } catch {
                                // If parsing fails or no content, skip accumulation
                            }
                            this.publishNestedRequestProgress(requestProgress);
                            streamEnded = requestProgress.progress === 1;
                            if (streamEnded) {
                                completionSent = true;
                            }
                        }
                    } catch (error) {
                        logger.error(`Could not publish the stream message: "${event.data}", ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
                    }

                }
                
                const sseParser = createParser(onParse);

                const processStream = (data) => {
                    sseParser.feed(data.toString());
                }

                if (incomingMessage) {
                    // Add timeout to prevent hanging forever
                    const streamTimeout = setTimeout(() => {
                        if (!completionSent && !streamErrorOccurred) {
                            streamErrorOccurred = true;
                            streamErrorMessage = 'Stream timeout - no data received for 5 minutes';
                            logger.error(streamErrorMessage);
                            incomingMessage.destroy();
                        }
                    }, 5 * 60 * 1000); // 5 minute timeout

                    try {
                        await new Promise((resolve, reject) => {
                            incomingMessage.on('data', processStream);
                            incomingMessage.on('end', resolve);
                            incomingMessage.on('error', (err) => {
                                streamErrorOccurred = true;
                                streamErrorMessage = err instanceof Error ? err.message : String(err);
                                reject(err);
                            });
                            incomingMessage.on('close', () => {
                                // Stream closed - only warn if we received SSE data but no completion
                                // Skip warning if: non-streaming (no SSE), tool callback invoked (expected close), or error occurred
                                if (receivedSSEData && !completionSent && !streamErrorOccurred && !toolCallbackInvoked) {
                                    logger.warn('Stream closed without completion signal');
                                }
                                resolve();
                            });
                        });
                    } finally {
                        clearTimeout(streamTimeout);
                    }
                }

            } catch (error) {
                streamErrorOccurred = true;
                if (!streamErrorMessage) {
                    streamErrorMessage = error instanceof Error ? error.message : String(error);
                }
                logger.error(`Could not subscribe to stream: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
            }

            // Ensure completion is sent if not already done
            // Only send completion if we were actually streaming (received SSE data)
            // Non-streaming responses (tool calls) should not send completion to parent
            // Don't send completion if a tool callback was invoked (stream will resume)
            if (receivedSSEData && !toolCallbackInvoked && (streamErrorOccurred || !completionSent)) {
                if (streamErrorOccurred) {
                    logger.error(`Stream read failed: ${streamErrorMessage}`);
                }
                const errorMessage = streamErrorOccurred 
                    ? (streamErrorMessage || this.errors.join(', ') || 'Stream read failed')
                    : '';
                publishRequestProgress({
                    requestId,
                    progress: 1,
                    data: '',
                    info: JSON.stringify(this.pathwayResultData || {}),
                    error: errorMessage
                });
            }
        }
    }

    async resolve(args) {
        // Either we're dealing with an async request, stream, or regular request
        if (args.async || args.stream) {
            if (!requestState[this.requestId]) {
                requestState[this.requestId] = {}
            }
            this.rootRequestId = args.rootRequestId ?? null;
            requestState[this.requestId] = { ...requestState[this.requestId], args, resolver: this.asyncResolve.bind(this), pathwayResolver: this };
            return this.requestId;
        }
        else {
            // Syncronously process the request
            return await this.executePathway(args);
        }
    }

    async executePathway(args) {
        // Set rootRequestId from args if provided (for tool pathways called from sys_entity_agent)
        // This ensures tool pathways inherit the rootRequestId from the parent resolver
        if (args.rootRequestId) {
            this.rootRequestId = args.rootRequestId;
        }
        
        // Bidirectional context transformation for backward compatibility:
        // 1. If agentContext provided: extract contextId/contextKey for legacy pathways
        // 2. If contextId provided without agentContext: create agentContext for new pathways
        if (args.agentContext && Array.isArray(args.agentContext) && args.agentContext.length > 0) {
            // Register ALL contextId/contextKey pairs for encryption lookup
            for (const ctx of args.agentContext) {
                if (ctx.contextId && ctx.contextKey) {
                    registerContextKey(ctx.contextId, ctx.contextKey);
                }
            }
            
            const defaultCtx = args.agentContext.find(ctx => ctx.default) || args.agentContext[0];
            if (defaultCtx) {
                args.contextId = defaultCtx.contextId;
                args.contextKey = defaultCtx.contextKey || null;
            }
        } else if (args.contextId && !args.agentContext) {
            // Backward compat: create agentContext from legacy contextId/contextKey
            args.agentContext = [{ 
                contextId: args.contextId, 
                contextKey: args.contextKey || null, 
                default: true 
            }];
            // Register this single pair
            if (args.contextId && args.contextKey) {
                registerContextKey(args.contextId, args.contextKey);
            }
        }
        
        if (this.pathway.executePathway && typeof this.pathway.executePathway === 'function') {
            return await this.pathway.executePathway({ args, runAllPrompts: this.promptAndParse.bind(this), resolver: this });
        }
        else {
            return await this.promptAndParse(args);
        }
    }

    async promptAndParse(args) {
        // Check if model is specified in args and swap if different from current model
        if (args.modelOverride && args.modelOverride !== this.modelName) {
            try {
                this.swapModel(args.modelOverride);
            } catch (error) {
                this.logError(`Failed to swap model to ${args.modelOverride}: ${error.message}`);
            }
        }

        // Get saved context from contextId or change contextId if needed
        const { contextId, useMemory } = args;
        this.savedContextId = contextId ? contextId : uuidv4();
        
        const useContinuityMemory = useMemory !== false;
        
        const loadMemory = async () => {
            try {
                // Always load savedContext (legacy feature, used for non-memory state)
                this.savedContext = (getvWithDoubleDecryption && await getvWithDoubleDecryption(this.savedContextId, this.savedContextId)) || {};
                this.initialState = { savedContext: this.savedContext };
                
                // === CONTINUITY MEMORY INTEGRATION ===
                // Load narrative context from the Continuity Architecture if enabled
                // When enabled, this replaces the legacy memory system
                if (useContinuityMemory) {
                    try {
                        const continuityService = getContinuityMemoryService();
                        if (continuityService.isAvailable() && args.entityId) {
                            // Extract entity and user identifiers
                            // Use args.entityId (UUID) for memory operations, not args.aiName (display name)
                            // If no entityId is provided, skip continuity memory entirely
                            const entityId = args.entityId;
                            const userId = this.savedContextId;
                            
                            // Extract current query from args.text or last USER message in chatHistory
                            // Prefer user messages over assistant/tool responses for semantic search
                            let currentQuery = args.text || '';
                            if (!currentQuery && args.chatHistory?.length > 0) {
                                // Find the last user message (not assistant/tool response)
                                let lastUserMessage = null;
                                for (let i = args.chatHistory.length - 1; i >= 0; i--) {
                                    const msg = args.chatHistory[i];
                                    if (msg?.role === 'user' || msg?.role === 'human') {
                                        lastUserMessage = msg;
                                        break;
                                    }
                                }
                                
                                // Fallback to last message if no user message found
                                const messageToUse = lastUserMessage || args.chatHistory.slice(-1)[0];
                                const content = messageToUse?.content;
                                
                                if (typeof content === 'string') {
                                    // Skip if it looks like a tool response JSON
                                    if (!content.trim().startsWith('{') || !content.includes('"success"')) {
                                        currentQuery = content;
                                    }
                                } else if (Array.isArray(content)) {
                                    // Content is array - could be strings or objects
                                    const firstItem = content[0];
                                    if (typeof firstItem === 'string') {
                                        // Skip if it looks like a tool response JSON
                                        if (!firstItem.trim().startsWith('{') || !firstItem.includes('"success"')) {
                                            // Try to parse as JSON (stringified content block)
                                            try {
                                                const parsed = JSON.parse(firstItem);
                                                currentQuery = parsed.text || parsed.content || firstItem;
                                            } catch {
                                                currentQuery = firstItem;
                                            }
                                        }
                                    } else if (firstItem?.text) {
                                        currentQuery = firstItem.text;
                                    } else if (firstItem?.content) {
                                        currentQuery = firstItem.content;
                                    }
                                }
                            }
                            currentQuery = typeof currentQuery === 'string' ? currentQuery : '';
                            
                            // Initialize session
                            await continuityService.initSession(entityId, userId);
                            
                            // Stale-while-revalidate: check Redis cache first
                            const cached = await continuityService.hotMemory?.getRenderedContextCache(entityId, userId);
                            
                            if (cached?.context) {
                                // Use cached context immediately, but add fresh time context
                                let context = cached.context || '';
                                
                                // Fetch expression state from Redis (fast) for fresh time data
                                try {
                                    const expressionState = await continuityService.hotMemory?.getExpressionState(entityId, userId);
                                    const timeContext = ContextBuilder.buildTimeContext(expressionState);
                                    if (timeContext) {
                                        context = context + '\n\n' + timeContext;
                                    }
                                } catch (timeErr) {
                                    logger.debug(`Could not add time context: ${timeErr.message}`);
                                }
                                
                                this.continuityContext = context;
                                this.continuityEntityId = entityId;
                                this.continuityUserId = userId;
                                logger.debug(`[PROFILE:mem] Using Redis cached context (${cached.context?.length || 0} chars, age: ${Date.now() - cached.timestamp}ms)`);
                                
                                // Refresh cache in background (fire-and-forget)
                                continuityService.getContextWindow({
                                    entityId,
                                    userId,
                                    query: currentQuery,
                                    options: {
                                        episodicLimit: 20,
                                        topicMemoryLimit: 10,
                                        bootstrapRelationalLimit: 10,
                                        bootstrapMinImportance: 5,
                                        expandGraph: true
                                    }
                                }).then(freshContext => {
                                    // Update Redis cache
                                    continuityService.hotMemory?.setRenderedContextCache(entityId, userId, freshContext || '');
                                    logger.debug(`[PROFILE:mem] Background refresh complete (${freshContext?.length || 0} chars)`);
                                }).catch(err => {
                                    logger.warn(`Background continuity refresh failed: ${err.message}`);
                                });
                            } else {
                                // No cache - must load synchronously (first request)
                                const loadStart = Date.now();
                                let continuityContext = await continuityService.getContextWindow({
                                    entityId,
                                    userId,
                                    query: currentQuery,
                                    options: {
                                        episodicLimit: 20,
                                        topicMemoryLimit: 10,
                                        bootstrapRelationalLimit: 10,
                                        bootstrapMinImportance: 5,
                                        expandGraph: true
                                    }
                                });
                                
                                // Cache to Redis WITHOUT time-sensitive parts
                                continuityService.hotMemory?.setRenderedContextCache(entityId, userId, continuityContext || '');
                                
                                // Add fresh time context for this request
                                try {
                                    const expressionState = await continuityService.hotMemory?.getExpressionState(entityId, userId);
                                    const timeContext = ContextBuilder.buildTimeContext(expressionState);
                                    if (timeContext && continuityContext) {
                                        continuityContext = continuityContext + '\n\n' + timeContext;
                                    }
                                } catch (timeErr) {
                                    logger.debug(`Could not add time context: ${timeErr.message}`);
                                }
                                
                                // Store for injection into prompts
                                this.continuityContext = continuityContext || '';
                                this.continuityEntityId = entityId;
                                this.continuityUserId = userId;
                                
                                logger.debug(`[PROFILE:mem] Loaded continuity context (${continuityContext?.length || 0} chars) in ${Date.now() - loadStart}ms (cold)`);
                            }
                        }
                    } catch (error) {
                        logger.warn(`Continuity memory load failed (non-fatal): ${error.message}`);
                        this.continuityContext = '';
                    }
                }
            } catch (error) {
                this.logError(`Error in loadMemory: ${error.message}`);
                this.savedContext = {};
                this.continuityContext = '';
                this.initialState = { savedContext: {} };
            }
        };

        const saveChangedMemory = async () => {
            // Always save savedContext (legacy feature, not governed by useMemory)
            this.savedContextId = this.savedContextId || uuidv4();
            
            const currentState = {
                savedContext: this.savedContext,
            };

            if (currentState.savedContext !== this.initialState.savedContext) {
                setvWithDoubleEncryption && await setvWithDoubleEncryption(this.savedContextId, this.savedContext, this.savedContextId);
            }
        };

        const MAX_RETRIES = 3;
        let data = null;
        
        for (let retries = 0; retries < MAX_RETRIES; retries++) {
            // Skip memory load if already loaded (e.g., intermediate tool calls)
            // The continuityContext from the first call persists on the resolver
            if (!args.skipMemoryLoad) {
                await loadMemory(); // Reset memory state on each retry
            }
            
            data = await this.processRequest(args);
            if (!data) {
                break;
            }

            // if data is a stream, handle it
            if (data && typeof data.on === 'function') {
                await this.handleStream(data);
                // Note: Continuity memory recording is handled by the agent (sys_entity_agent.js)
                // after the full agentic workflow completes. This avoids recording intermediate
                // tool-calling turns and ensures only one turn is recorded per user message.
                return data;
            }

            data = await this.responseParser.parse(data);
            if (data !== null) {
                break;
            }

            logger.warn(`Bad pathway result - retrying pathway. Attempt ${retries + 1} of ${MAX_RETRIES}`);
        }

        if (data !== null) {
            await saveChangedMemory();
            // Note: Continuity memory recording is handled by the agent (sys_entity_agent.js)
            // after the full agentic workflow completes.
        }

        addCitationsToResolver(this, data);

        return data;
    }

    // Add a warning and log it
    logWarning(warning) {
        this.warnings.push(warning);
        logger.warn(warning);
    }

    // Add an error and log it
    logError(error) {
        // Extract message from error object, handle strings and undefined
        const errorMessage = error instanceof Error 
            ? error.message 
            : (typeof error === 'string' ? error : String(error ?? 'Unknown error'));
        this.errors.push(errorMessage);
        logger.error(errorMessage);
    }

    // Here we choose how to handle long input - either summarize or chunk
    processInputText(text) {
        let chunkTokenLength = 0;
        if (this.pathway.inputChunkSize) {
            chunkTokenLength = this.pathway.inputChunkSize;
        } else {
            chunkTokenLength = this.chunkMaxTokenLength;
        }
        const encoded = text ? encode(text) : [];
        if (!this.useInputChunking) { // no chunking, return as is
            if (encoded.length > 0 && encoded.length >= chunkTokenLength) {
                const warnText = `Truncating long input text. Text length: ${text.length}`;
                this.logWarning(warnText);
                text = this.truncate(text, chunkTokenLength);
            }
            return [text];
        }

        // chunk the text and return the chunks with newline separators
        return getSemanticChunks(text, chunkTokenLength, this.pathway.inputFormat);
    }

    truncate(str, n) {
        if (this.modelExecutor.plugin.promptParameters.truncateFromFront) {
            return getFirstNToken(str, n);
        }
        return getLastNToken(str, n);
    }

    async summarizeIfEnabled({ text, ...parameters }) {
        if (this.pathway.useInputSummarization) {
            return await callPathway('summary', { ...this.args, ...parameters, targetLength: 0});
        }
        return text;
    }

    // Calculate the maximum token length for a chunk
    getChunkMaxTokenLength() {
        // Skip expensive calculations if not using input chunking
        if (!this.useInputChunking) {
            return this.modelExecutor.plugin.getModelMaxPromptTokens();
        }

        // find the longest prompt
        const maxPromptTokenLength = Math.max(...this.prompts.map((promptData) => this.modelExecutor.plugin.getCompiledPrompt('', this.args, promptData).tokenLength));
        
        // find out if any prompts use both text input and previous result
        const hasBothProperties = this.prompts.some(prompt => prompt.usesTextInput && prompt.usesPreviousResult);
        
        let chunkMaxTokenLength = this.modelExecutor.plugin.getModelMaxPromptTokens() - maxPromptTokenLength - 1;
        
        // if we have to deal with prompts that have both text input
        // and previous result, we need to split the maxChunkToken in half
        chunkMaxTokenLength = hasBothProperties ? chunkMaxTokenLength / 2 : chunkMaxTokenLength;
        
        return chunkMaxTokenLength;
    }

    // Process the request and return the result        
    async processRequest({ text, ...parameters }) {
        text = await this.summarizeIfEnabled({ text, ...parameters }); // summarize if flag enabled
        const chunks = text && this.processInputText(text) || [text];

        let anticipatedRequestCount = chunks.length * this.prompts.length   

        if ((requestState[this.requestId] || {}).canceled) {
            throw new Error('Request canceled');
        }

        // Store the request state
        requestState[this.requestId] = { ...requestState[this.requestId], totalCount: anticipatedRequestCount, completedCount: 0 };

        if (chunks.length > 1) { 
            // stream behaves as async if there are multiple chunks
            if (parameters.stream) {
                parameters.async = true;
                parameters.stream = false;
            }
        }

        // If pre information is needed, apply current prompt with previous prompt info, only parallelize current call
        if (this.pathway.useParallelChunkProcessing) {
            // Apply each prompt across all chunks in parallel
            // this.previousResult is not available at the object level as it is different for each chunk
            this.previousResult = '';
            const data = await Promise.all(chunks.map(chunk =>
                this.applyPromptsSerially(chunk, parameters)));
            // Join the chunks with newlines
            return data.join(this.pathway.joinChunksWith || "\n\n");
        } else {
            // Apply prompts one by one, serially, across all chunks
            // This is the default processing mode and will make previousResult available at the object level
            let previousResult = '';
            let result = '';

            for (let i = 0; i < this.prompts.length; i++) {
                const currentParameters = { ...parameters, previousResult };

                if (currentParameters.stream) { // stream special flow
                    if (i < this.prompts.length - 1) { 
                        currentParameters.stream = false; // if not the last prompt then don't stream
                    }
                    else {
                        // use the stream parameter if not async
                        currentParameters.stream = currentParameters.async ? false : currentParameters.stream;
                    }
                }

                // If the prompt doesn't contain {{text}} then we can skip the chunking, and also give that token space to the previous result
                if (!this.prompts[i].usesTextInput) {
                    // Limit context to it's N + text's characters
                    if (previousResult) {
                        previousResult = this.truncate(previousResult, 2 * this.chunkMaxTokenLength);
                    }
                    result = await this.applyPrompt(this.prompts[i], text, currentParameters);
                } else {
                    // Limit context to N characters
                    if (previousResult) {
                        previousResult = this.truncate(previousResult, this.chunkMaxTokenLength);
                    }
                    result = await Promise.all(chunks.map(chunk =>
                        this.applyPrompt(this.prompts[i], chunk, currentParameters)));

                    if (result.length === 1) {
                        result = result[0];
                    } else if (!currentParameters.stream) {
                        result = result.join(this.pathway.joinChunksWith || "\n\n");
                    }
                }

                // If this is any prompt other than the last, use the result as the previous context
                if (i < this.prompts.length - 1) {
                    previousResult = result;
                    if (result instanceof CortexResponse) {
                        previousResult = result.output_text;
                    }
                }
            }
            // store the previous result in the PathwayResolver
            this.previousResult = previousResult;
            return result;
        }

    }

    async applyPromptsSerially(text, parameters) {
        let previousResult = '';
        let result = '';
        for (const prompt of this.prompts) {
            previousResult = result;
            result = await this.applyPrompt(prompt, text, { ...parameters, previousResult });
        }
        return result;
    }

    /**
     * Swaps the model used by this PathwayResolver
     * @param {string} newModelName - The name of the new model to use
     * @throws {Error} If the new model is not found in the endpoints
     */
    swapModel(newModelName) {
        // Validate that the new model exists in endpoints
        if (!this.endpoints[newModelName]) {
            throw new Error(`Model ${newModelName} not found in config`);
        }

        // Update model references
        this.modelName = newModelName;
        this.model = this.endpoints[newModelName];

        // Create new ModelExecutor with the new model
        this.modelExecutor = new ModelExecutor(this.pathway, this.model);

        // Recalculate chunk max token length as it depends on the model
        this.chunkMaxTokenLength = this.getChunkMaxTokenLength();

        this.logWarning(`Model swapped to ${newModelName}`);
    }

    async applyPrompt(prompt, text, parameters) {
        if (requestState[this.requestId].canceled) {
            return;
        }
        let result = '';

        result = await this.modelExecutor.execute(text, { 
            ...parameters, 
            ...this.savedContext,
            // Continuity Memory context (narrative layer)
            continuityContext: this.continuityContext || ''
        }, prompt, this);
        
        requestState[this.requestId].completedCount++;

        if (parameters.async) {
            const { completedCount, totalCount } = requestState[this.requestId];

            if (completedCount < totalCount) {
                await publishRequestProgress({
                        requestId: this.requestId,
                        progress: completedCount / totalCount,
                });
            }
        }

        // save the result to the context if requested and no errors
        if (prompt.saveResultTo && this.errors.length === 0) {
            this.savedContext[prompt.saveResultTo] = result;
        }
        return result;
    }
}

export { PathwayResolver };
