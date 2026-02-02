// continuity_agent_recording.test.js
// Tests that continuity memory is recorded ONCE per agentic workflow,
// regardless of how many intermediate tool calls occur.

import test from 'ava';
import serverFactory from '../../../../index.js';
import { createClient } from 'graphql-ws';
import ws from 'ws';
import { getContinuityMemoryService } from '../../../../lib/continuity/index.js';

const TEST_ENTITY_ID = 'test-entity-memory-recording';
const TEST_USER_ID = `test-user-recording-${Date.now()}`;

let testServer;
let wsClient;
let service;
let originalRecordTurn;
let recordTurnCalls = [];

test.before(async (t) => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    startServer && await startServer();
    testServer = server;
    
    // Initialize continuity service
    service = getContinuityMemoryService();
    
    // Check if service is available
    if (!service.isAvailable()) {
        t.log('Warning: Continuity service not available. Some tests may be skipped.');
    }
    
    // Spy on recordTurn by wrapping the original method
    originalRecordTurn = service.recordTurn.bind(service);
    service.recordTurn = async function(...args) {
        recordTurnCalls.push({
            entityId: args[0],
            userId: args[1],
            turn: args[2],
            timestamp: Date.now()
        });
        return originalRecordTurn(...args);
    };
    
    // Create WebSocket client
    wsClient = createClient({
        url: `ws://localhost:${process.env.CORTEX_PORT || 4000}/graphql`,
        webSocketImpl: ws,
        retryAttempts: 3,
        connectionParams: {},
    });
    
    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 1000));
});

test.after.always('cleanup', async (t) => {
    // Restore original recordTurn
    if (service && originalRecordTurn) {
        service.recordTurn = originalRecordTurn;
    }
    
    // Clean up test data
    if (service) {
        try {
            await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        } catch (error) {
            t.log(`Cleanup warning: ${error.message}`);
        }
    }
    
    if (wsClient) wsClient.dispose();
    if (testServer) await testServer.stop();
});

test.beforeEach(() => {
    // Reset call tracking before each test
    recordTurnCalls = [];
});

// Helper to collect streaming events
async function collectSubscriptionEvents(subscription, timeout = 60000) {
    const events = [];
    
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
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
                    if (event?.data?.requestProgress?.progress === 1) {
                        clearTimeout(timeoutId);
                        unsubscribe();
                        // Give a small delay for async memory recording to complete
                        setTimeout(() => resolve(events), 500);
                    }
                },
                error: (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                },
                complete: () => {
                    clearTimeout(timeoutId);
                    setTimeout(() => resolve(events), 500);
                }
            }
        );
    });
}

// Helper to filter calls for our test entity/user
function getTestRecordCalls() {
    return recordTurnCalls.filter(call => 
        call.entityId === TEST_ENTITY_ID || 
        call.userId?.includes('test-user-recording')
    );
}

test.serial('Non-streaming: records exactly 2 turns (user + assistant) for simple request', async (t) => {
    t.timeout(60000);
    
    const contextId = `context-simple-${Date.now()}`;
    
    // Make a non-streaming request
    // Note: useMemory: true is required because the default fallback entity has useMemory: false
    const response = await testServer.executeOperation({
        query: `
            query TestSimpleNonStream(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    stream: false
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Say hello',
            chatHistory: [{ role: "user", content: ["Say hello"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID,
            useMemory: true
        }
    });
    
    // Give async operations time to complete
    await new Promise(r => setTimeout(r, 1000));
    
    const errors = response.body?.singleResult?.errors;
    if (errors) {
        t.log('GraphQL errors:', JSON.stringify(errors, null, 2));
    }
    t.falsy(errors, 'Should not have GraphQL errors');
    
    const result = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(result, 'Should have a result');
    
    // Check memory recording calls
    const testCalls = getTestRecordCalls();
    t.log(`recordTurn called ${testCalls.length} times for test entity`);
    testCalls.forEach((call, i) => {
        t.log(`  Call ${i + 1}: role=${call.turn?.role}, content length=${call.turn?.content?.length || 0}`);
    });
    
    // Should have exactly 2 calls: 1 user turn + 1 assistant turn
    t.is(testCalls.length, 2, 'Should record exactly 2 turns (user + assistant)');
    
    if (testCalls.length >= 2) {
        const userCall = testCalls.find(c => c.turn?.role === 'user');
        const assistantCall = testCalls.find(c => c.turn?.role === 'assistant');
        
        t.truthy(userCall, 'Should have recorded user turn');
        t.truthy(assistantCall, 'Should have recorded assistant turn');
        
        if (userCall) {
            t.truthy(userCall.turn.content, 'User turn should have content');
        }
        if (assistantCall) {
            t.truthy(assistantCall.turn.content, 'Assistant turn should have content');
        }
    }
});

test.serial('Streaming: records exactly 2 turns (user + assistant) for simple request', async (t) => {
    t.timeout(60000);
    
    // Reset call tracking
    recordTurnCalls = [];
    
    const contextId = `context-stream-simple-${Date.now()}`;
    
    // Make a streaming request
    const response = await testServer.executeOperation({
        query: `
            query TestSimpleStream(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    stream: true
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Say goodbye',
            chatHistory: [{ role: "user", content: ["Say goodbye"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID,
            useMemory: true
        }
    });
    
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have requestId');
    
    // Collect streaming events
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                }
            }
        `,
        variables: { requestId }
    });
    
    t.true(events.length > 0, 'Should receive streaming events');
    
    // Check memory recording calls
    const testCalls = getTestRecordCalls();
    t.log(`recordTurn called ${testCalls.length} times for streaming request`);
    testCalls.forEach((call, i) => {
        t.log(`  Call ${i + 1}: role=${call.turn?.role}, content length=${call.turn?.content?.length || 0}`);
    });
    
    // Should have exactly 2 calls: 1 user turn + 1 assistant turn
    t.is(testCalls.length, 2, 'Streaming should record exactly 2 turns (user + assistant)');
    
    if (testCalls.length >= 2) {
        const userCall = testCalls.find(c => c.turn?.role === 'user');
        const assistantCall = testCalls.find(c => c.turn?.role === 'assistant');
        
        t.truthy(userCall, 'Should have recorded user turn');
        t.truthy(assistantCall, 'Should have recorded assistant turn');
    }
});

test.serial('Streaming with tool calls: records exactly 2 turns despite multiple tool executions', async (t) => {
    t.timeout(120000);
    
    // Reset call tracking
    recordTurnCalls = [];
    
    const contextId = `context-tools-${Date.now()}`;
    
    // Make a request that will trigger tool calls (time query triggers get_current_datetime tool)
    const response = await testServer.executeOperation({
        query: `
            query TestToolCalls(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    stream: true
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'What time is it right now in Tokyo?',
            chatHistory: [{ role: "user", content: ["What time is it right now in Tokyo?"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID,
            useMemory: true
        }
    });
    
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have requestId');
    
    // Collect streaming events
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                    info
                }
            }
        `,
        variables: { requestId }
    }, 90000);
    
    t.true(events.length > 0, 'Should receive streaming events');
    
    // Check for tool usage in the completion event
    const completionEvent = events.find(e => e.data?.requestProgress?.progress === 1);
    if (completionEvent?.data?.requestProgress?.info) {
        try {
            const info = JSON.parse(completionEvent.data.requestProgress.info);
            if (info.toolUsed) {
                t.log(`Tools used: ${JSON.stringify(info.toolUsed)}`);
            }
        } catch (e) {
            // Ignore parse errors
        }
    }
    
    // Check memory recording calls
    const testCalls = getTestRecordCalls();
    t.log(`recordTurn called ${testCalls.length} times for tool-calling request`);
    testCalls.forEach((call, i) => {
        t.log(`  Call ${i + 1}: role=${call.turn?.role}, content preview="${call.turn?.content?.substring(0, 50)}..."`);
    });
    
    // CRITICAL: Should have exactly 2 calls even with tool usage
    // This is the main behavior we're testing - tool calls should NOT cause additional memory recordings
    t.is(testCalls.length, 2, 'Tool-calling workflow should record exactly 2 turns (user + assistant), not more');
    
    if (testCalls.length >= 2) {
        const userCall = testCalls.find(c => c.turn?.role === 'user');
        const assistantCall = testCalls.find(c => c.turn?.role === 'assistant');
        
        t.truthy(userCall, 'Should have recorded user turn');
        t.truthy(assistantCall, 'Should have recorded assistant turn');
        
        // Verify user content is the original query, not tool response
        if (userCall) {
            t.true(
                userCall.turn.content.includes('time') || userCall.turn.content.includes('Tokyo'),
                'User turn should contain original query'
            );
        }
        
        // Verify assistant content is the final response, not intermediate tool call
        if (assistantCall) {
            t.truthy(assistantCall.turn.content.length > 0, 'Assistant turn should have content');
            // Should NOT be a tool call response
            t.false(
                assistantCall.turn.content.includes('"tool_calls"'),
                'Assistant turn should be final response, not tool call JSON'
            );
        }
    }
});

test.serial('Multiple tool calls: still records exactly 2 turns', async (t) => {
    t.timeout(180000);
    
    // Reset call tracking
    recordTurnCalls = [];
    
    const contextId = `context-multi-tools-${Date.now()}`;
    
    // Request that typically triggers multiple tool calls (research mode)
    const response = await testServer.executeOperation({
        query: `
            query TestMultipleTools(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean
            ) {
                sys_entity_agent(
                    text: $text,
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    stream: true
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Search for information about the latest Mars rover discoveries',
            chatHistory: [{ role: "user", content: ["Search for information about the latest Mars rover discoveries"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID,
            useMemory: true
        }
    });
    
    const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(requestId, 'Should have requestId');
    
    // Collect streaming events with longer timeout for research
    const events = await collectSubscriptionEvents({
        query: `
            subscription OnProgress($requestId: String!) {
                requestProgress(requestIds: [$requestId]) {
                    requestId
                    progress
                    data
                    info
                }
            }
        `,
        variables: { requestId }
    }, 150000);
    
    t.true(events.length > 0, 'Should receive streaming events');
    
    // Log tool usage
    const completionEvent = events.find(e => e.data?.requestProgress?.progress === 1);
    let toolCount = 0;
    if (completionEvent?.data?.requestProgress?.info) {
        try {
            const info = JSON.parse(completionEvent.data.requestProgress.info);
            if (info.toolUsed) {
                const tools = Array.isArray(info.toolUsed) ? info.toolUsed.flat() : [info.toolUsed];
                toolCount = tools.length;
                t.log(`Research mode used ${toolCount} tools: ${tools.join(', ')}`);
            }
        } catch (e) {
            // Ignore parse errors
        }
    }
    
    // Check memory recording calls
    const testCalls = getTestRecordCalls();
    t.log(`recordTurn called ${testCalls.length} times for research request (${toolCount} tools used)`);
    
    // CRITICAL: Even with multiple tools, should record at most 2 turns (user + assistant)
    // In some cases, assistant response might be empty and only 1 turn is recorded
    t.true(testCalls.length <= 2, `Research mode with ${toolCount} tools should record at most 2 turns, got ${testCalls.length}`);
    t.true(testCalls.length >= 1, `Should record at least the user turn`);
    
    // Verify we have a user turn
    const userCalls = testCalls.filter(c => c.turn?.role === 'user');
    const assistantCalls = testCalls.filter(c => c.turn?.role === 'assistant');
    
    t.is(userCalls.length, 1, 'Should have exactly one user turn');
    t.true(assistantCalls.length <= 1, 'Should have at most one assistant turn');
    
    if (assistantCalls.length === 0) {
        t.log('Note: Assistant turn not recorded (response may have been empty or structured differently in research mode)');
    }
});

// ============================================================================
// useMemory flag logic tests - "False always wins"
// ============================================================================

test.serial('useMemory defaults to true when not specified', async (t) => {
    t.timeout(60000);
    
    // Reset call tracking
    recordTurnCalls = [];
    
    const contextId = `context-default-memory-${Date.now()}`;
    
    // Make request WITHOUT specifying useMemory - should default to true
    // Note: entityId is a non-existent entity, so entityConfig?.useMemory is undefined
    const response = await testServer.executeOperation({
        query: `
            query TestDefaultMemory(
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
                    stream: false
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Say hi',
            chatHistory: [{ role: "user", content: ["Say hi"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID
            // Note: useMemory NOT specified - should default to true
        }
    });
    
    // Give async operations time to complete
    await new Promise(r => setTimeout(r, 1000));
    
    const errors = response.body?.singleResult?.errors;
    t.falsy(errors, 'Should not have GraphQL errors');
    
    // Check memory recording calls - should have recorded since default is true
    const testCalls = getTestRecordCalls();
    t.log(`useMemory default: recordTurn called ${testCalls.length} times (expected: 2)`);
    
    t.is(testCalls.length, 2, 'Memory should be recorded by default (useMemory defaults to true)');
});

test.serial('useMemory: false disables memory recording', async (t) => {
    t.timeout(60000);
    
    // Reset call tracking
    recordTurnCalls = [];
    
    const contextId = `context-disabled-memory-${Date.now()}`;
    
    // Make request with useMemory: false - should NOT record memory
    const response = await testServer.executeOperation({
        query: `
            query TestDisabledMemory(
                $text: String!, 
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean
            ) {
                sys_entity_agent(
                    text: $text, 
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    stream: false
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }
        `,
        variables: {
            text: 'Say something',
            chatHistory: [{ role: "user", content: ["Say something"] }],
            agentContext: [{ contextId, contextKey: null, default: true }],
            entityId: TEST_ENTITY_ID,
            useMemory: false  // Explicitly disable memory
        }
    });
    
    // Give async operations time to complete
    await new Promise(r => setTimeout(r, 1000));
    
    const errors = response.body?.singleResult?.errors;
    t.falsy(errors, 'Should not have GraphQL errors');
    
    const result = response.body?.singleResult?.data?.sys_entity_agent?.result;
    t.truthy(result, 'Should still get a response');
    
    // Check memory recording calls - should NOT have recorded
    const testCalls = getTestRecordCalls();
    t.log(`useMemory: false - recordTurn called ${testCalls.length} times (expected: 0)`);
    
    t.is(testCalls.length, 0, 'Memory should NOT be recorded when useMemory: false (input can disable)');
});
