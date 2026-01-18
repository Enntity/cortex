// web_agent_delegation.test.js
// End-to-end tests for the WebAgent subagent delegation system
// Tests both direct WebAgent invocation and delegation via WebResearch tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import { createClient } from 'graphql-ws';
import ws from 'ws';

let testServer;
let wsClient;

test.before(async () => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    startServer && await startServer();
    testServer = server;

    // Create WebSocket client for subscriptions
    wsClient = createClient({
        url: `ws://localhost:${process.env.CORTEX_PORT || 4000}/graphql`,
        webSocketImpl: ws,
        retryAttempts: 3,
        connectionParams: {},
        on: {
            error: (error) => {
                console.error('WS connection error:', error);
            }
        }
    });

    // Test the connection
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve(), 2000);
            wsClient.subscribe(
                {
                    query: `
                        subscription TestConnection {
                            requestProgress(requestIds: ["test"]) {
                                requestId
                            }
                        }
                    `
                },
                {
                    next: () => {
                        clearTimeout(timeout);
                        resolve();
                    },
                    error: reject,
                    complete: () => {
                        clearTimeout(timeout);
                        resolve();
                    }
                }
            );
        });
    } catch (error) {
        console.error('Failed to establish WebSocket connection:', error);
        throw error;
    }
});

test.after.always('cleanup', async () => {
    if (wsClient) {
        wsClient.dispose();
    }
    if (testServer) {
        await testServer.stop();
    }
});

// Helper function to collect subscription events
async function collectSubscriptionEvents(subscription, timeout = 180000) {
    const events = [];
    let completionReceived = false;

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.log(`Subscription timeout after ${timeout}ms with ${events.length} events, completion: ${completionReceived}`);
            if (events.length > 0) {
                resolve(events);
            } else {
                reject(new Error('Subscription timed out with no events'));
            }
        }, timeout);

        const unsubscribe = wsClient.subscribe(
            {
                query: subscription.query,
                variables: subscription.variables
            },
            {
                next: (event) => {
                    events.push(event);
                    // Check for completion event
                    if (event?.data?.requestProgress?.progress === 1) {
                        completionReceived = true;
                        console.log(`Completion event received after ${events.length} events`);
                        clearTimeout(timeoutId);
                        unsubscribe();
                        resolve(events);
                    }
                },
                error: (error) => {
                    clearTimeout(timeoutId);
                    console.error('Subscription error:', error);
                    reject(error);
                },
                complete: () => {
                    clearTimeout(timeoutId);
                    resolve(events);
                }
            }
        );
    });
}

// Helper to get WebAgent entity ID
async function getWebAgentEntityId() {
    // Import the helper function to look up the WebAgent entity
    const { getSystemEntity } = await import('../../../../pathways/system/entity/tools/shared/sys_entity_tools.js');
    const webAgent = getSystemEntity('WebAgent');
    if (!webAgent || !webAgent.id) {
        throw new Error('WebAgent system entity not found');
    }
    return webAgent.id;
}

// Test 1: WebAgent entity exists and has correct configuration
test.serial('WebAgent system entity is bootstrapped correctly', async (t) => {
    t.timeout(30000);
    
    const { getSystemEntity } = await import('../../../../pathways/system/entity/tools/shared/sys_entity_tools.js');
    const webAgent = getSystemEntity('WebAgent');
    
    t.truthy(webAgent, 'WebAgent entity should exist');
    t.is(webAgent.name, 'WebAgent', 'Entity name should be WebAgent');
    t.true(webAgent.isSystem, 'WebAgent should be a system entity');
    t.false(webAgent.useMemory, 'WebAgent should not use continuity memory');
    
    // Check tool configuration
    t.true(Array.isArray(webAgent.tools), 'WebAgent should have tools array');
    t.true(webAgent.tools.includes('SearchInternet'), 'WebAgent should have SearchInternet tool');
    t.true(webAgent.tools.includes('SearchXPlatform'), 'WebAgent should have SearchXPlatform tool');
    t.true(webAgent.tools.includes('FetchWebPageContent'), 'WebAgent should have FetchWebPageContent tool');
    
    console.log('WebAgent entity configuration:', {
        id: webAgent.id,
        name: webAgent.name,
        tools: webAgent.tools,
        baseModel: webAgent.baseModel
    });
});

// Test 2: Direct WebAgent invocation - verify it can perform searches
test.serial('WebAgent can perform web searches directly', async (t) => {
    t.timeout(300000); // 5 minute timeout for search operations (agent may make multiple tool calls)
    
    const webAgentEntityId = await getWebAgentEntityId();
    console.log(`Testing direct WebAgent invocation with entity ID: ${webAgentEntityId}`);
    
    const contextId = `webagent-direct-${Date.now()}`;
    const response = await testServer.executeOperation({
        query: `
            query TestWebAgentDirect(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    stream: true,
                    useMemory: false,
                    researchMode: true
                ) {
                    result
                    contextId
                    tool
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Search for recent news about artificial intelligence developments in 2024',
            chatHistory: [{
                role: "user",
                content: ["Search for recent news about artificial intelligence developments in 2024"]
            }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: webAgentEntityId
        }
    });

    console.log('WebAgent direct response:', JSON.stringify(response, null, 2));
    
    // Check for successful response
    t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have a requestId in the result field');

    // Collect events with extended timeout for multi-tool search operations
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnRequestProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                    info
                }
            }
        `,
        variables: { requestId }
    }, 240000); // 4 minute timeout for WebAgent searches

    console.log(`Received ${events.length} events for WebAgent direct test`);
    t.true(events.length > 0, 'Should have received events');

    // Verify we got a completion event
    const completionEvent = events.find(event =>
        event.data.requestProgress.progress === 1
    );
    t.truthy(completionEvent, 'Should have received a completion event');

    // Check that data was returned
    const dataEvents = events.filter(e => e.data?.requestProgress?.data);
    t.true(dataEvents.length > 0, 'Should have received data events');
    
    // Concatenate all data
    const fullResponse = dataEvents.map(e => e.data.requestProgress.data).join('');
    console.log('WebAgent response length:', fullResponse.length);
    t.true(fullResponse.length > 100, 'WebAgent should return substantial research results');

    // Check info for tool usage
    const infoString = completionEvent.data.requestProgress.info;
    if (infoString && infoString.trim()) {
        try {
            const infoObject = JSON.parse(infoString);
            console.log('WebAgent tool usage info:', JSON.stringify(infoObject, null, 2));
            
            // Verify search tools were used
            if (infoObject.toolUsed) {
                const toolsUsed = Array.isArray(infoObject.toolUsed) 
                    ? infoObject.toolUsed.flat() 
                    : [infoObject.toolUsed];
                const hasSearchTool = toolsUsed.some(tool => 
                    tool.includes('Search') || tool.includes('WebPage')
                );
                t.true(hasSearchTool, 'WebAgent should have used search tools');
            }
        } catch (e) {
            console.log('Could not parse info object:', e.message);
        }
    }
});

// Test 3: WebResearch delegation tool - verify it delegates to WebAgent
test.serial('WebResearch tool delegates to WebAgent correctly', async (t) => {
    t.timeout(300000); // 5 minute timeout for delegation + search
    
    const contextId = `webresearch-delegation-${Date.now()}`;
    
    // Use the default entity (which has access to all tools including WebResearch)
    const response = await testServer.executeOperation({
        query: `
            query TestWebResearchDelegation(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput]
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    stream: true,
                    useMemory: false
                ) {
                    result
                    contextId
                    tool
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Use the WebResearch tool to find out what happened at CES 2024',
            chatHistory: [{
                role: "user",
                content: ["Use the WebResearch tool to find out what happened at CES 2024"]
            }],
            agentContext: [{ contextId, contextKey: null, default: true }]
        }
    });

    console.log('WebResearch delegation response:', JSON.stringify(response, null, 2));
    
    // Check for successful response
    t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have a requestId in the result field');

    // Collect events with longer timeout for delegation
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnRequestProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                    info
                }
            }
        `,
        variables: { requestId }
    }, 240000);

    console.log(`Received ${events.length} events for WebResearch delegation test`);
    t.true(events.length > 0, 'Should have received events');

    // Verify we got a completion event
    const completionEvent = events.find(event =>
        event.data.requestProgress.progress === 1
    );
    t.truthy(completionEvent, 'Should have received a completion event');

    // Check that data was returned
    const dataEvents = events.filter(e => e.data?.requestProgress?.data);
    t.true(dataEvents.length > 0, 'Should have received data events');
    
    // Concatenate all data
    const fullResponse = dataEvents.map(e => e.data.requestProgress.data).join('');
    console.log('Delegation response length:', fullResponse.length);
    t.true(fullResponse.length > 100, 'Delegation should return substantial results');

    // Check info for WebResearch tool usage
    const infoString = completionEvent.data.requestProgress.info;
    if (infoString && infoString.trim()) {
        try {
            const infoObject = JSON.parse(infoString);
            console.log('Delegation tool usage info:', JSON.stringify(infoObject, null, 2));
            
            // Verify WebResearch was used
            if (infoObject.toolUsed) {
                const toolsUsed = Array.isArray(infoObject.toolUsed) 
                    ? infoObject.toolUsed.flat() 
                    : [infoObject.toolUsed];
                const hasWebResearch = toolsUsed.some(tool => 
                    tool.includes('WebResearch')
                );
                t.true(hasWebResearch, 'Main agent should have used WebResearch delegation tool');
                console.log('Tools used:', toolsUsed);
            }
        } catch (e) {
            console.log('Could not parse info object:', e.message);
        }
    }
});

// Test 4: WebAgent handles errors gracefully
test.serial('WebAgent handles invalid queries gracefully', async (t) => {
    t.timeout(60000);
    
    const webAgentEntityId = await getWebAgentEntityId();
    const contextId = `webagent-error-${Date.now()}`;
    
    const response = await testServer.executeOperation({
        query: `
            query TestWebAgentError(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    stream: true,
                    useMemory: false
                ) {
                    result
                    contextId
                    tool
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Just say hello - do not use any tools',
            chatHistory: [{
                role: "user",
                content: ["Just say hello - do not use any tools"]
            }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: webAgentEntityId
        }
    });

    // Should still return successfully even for non-search queries
    t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have a requestId');

    // Collect events
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnRequestProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                    info
                }
            }
        `,
        variables: { requestId }
    }, 30000);

    // Should complete without errors
    const completionEvent = events.find(event =>
        event.data.requestProgress.progress === 1
    );
    t.truthy(completionEvent, 'Should complete gracefully');
});
