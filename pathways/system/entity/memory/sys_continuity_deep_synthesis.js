/**
 * Continuity Deep Synthesis Pathway
 * 
 * Runs deep memory consolidation and pattern recognition in two phases.
 * Supports async mode with progress updates via GraphQL subscriptions.
 * 
 * PHASE 1: CONSOLIDATION - Per-memory processing (sleep-style)
 * PHASE 2: DISCOVERY - Batch pattern recognition
 * 
 * Input: entityId, userId, phase1Max, phase2Max, daysToLookBack, runPhase1, runPhase2
 * Output: JSON with consolidation results
 */

import { getContinuityMemoryService } from '../../../../lib/continuity/index.js';
import logger from '../../../../lib/logger.js';
import { publishRequestProgress } from '../../../../lib/redisSubscription.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        entityId: ``,       // Entity identifier (AI name)
        userId: ``,         // User/context identifier
        phase1Max: { type: 'integer', default: 100 },  // Max memories for consolidation
        phase2Max: { type: 'integer', default: 100 },  // Max memories for discovery
        daysToLookBack: { type: 'integer', default: 90 }, // How far back to look (null/0 = all memories)
        runPhase1: { type: 'boolean', default: true },  // Run consolidation phase
        runPhase2: { type: 'boolean', default: true }, // Run discovery phase
    },
    timeout: 600, // 10 minutes - this is a long-running operation
    
    executePathway: async ({ args, resolver }) => {
        const { 
            entityId, 
            userId, 
            phase1Max = 100, 
            phase2Max = 100, 
            daysToLookBack = 90,
            runPhase1 = true,
            runPhase2 = true
        } = args;
        
        const requestId = resolver?.requestId || resolver?.rootRequestId;
        const isAsync = args.async || false;
        
        const publishProgress = (progress, data = null, info = null, error = null) => {
            if (isAsync && requestId) {
                publishRequestProgress({
                    requestId,
                    progress,
                    data: data ? JSON.stringify(data) : '',
                    info: info ? JSON.stringify(info) : '',
                    error: error || ''
                });
            }
        };
        
        if (!entityId || !userId) {
            const error = 'entityId and userId are required';
            publishProgress(1, null, null, error);
            return JSON.stringify({
                success: false,
                error
            });
        }
        
        try {
            const service = getContinuityMemoryService();
            
            if (!service.isAvailable()) {
                const error = 'Continuity memory service is not available';
                publishProgress(1, null, null, error);
                return JSON.stringify({
                    success: false,
                    error
                });
            }
            
            logger.info(`Starting deep synthesis for ${entityId}/${userId} (Phase 1: ${runPhase1}, Phase 2: ${runPhase2})`);
            publishProgress(0.05, null, { phase: 'initializing', message: 'Starting deep synthesis...' });
            
            const results = {
                phase1: null,
                phase2: null,
                success: true
            };
            
            // Phase 1: Consolidation
            if (runPhase1) {
                publishProgress(0.1, null, { phase: 'phase1', message: 'Starting consolidation phase...' });
                
                const phase1Result = await service.runSleepSynthesis(entityId, userId, {
                    maxToProcess: phase1Max,
                    maxLookbackDays: daysToLookBack === 0 || daysToLookBack === null ? null : daysToLookBack,
                    windowSize: 20,
                    similarityLimit: 5
                });
                
                results.phase1 = phase1Result;
                publishProgress(0.5, null, { 
                    phase: 'phase1', 
                    message: 'Consolidation complete',
                    stats: phase1Result
                });
                
                logger.info(`Phase 1 complete: ${phase1Result.processed || 0} processed, ${phase1Result.absorbed || 0} absorbed, ${phase1Result.merged || 0} merged`);
            }
            
            // Phase 2: Discovery
            if (runPhase2) {
                publishProgress(0.55, null, { phase: 'phase2', message: 'Starting discovery phase...' });
                
                const phase2Result = await service.runDeepSynthesis(entityId, userId, {
                    maxMemories: phase2Max,
                    daysToLookBack: daysToLookBack === 0 || daysToLookBack === null ? null : daysToLookBack
                });
                
                results.phase2 = phase2Result;
                publishProgress(0.95, null, { 
                    phase: 'phase2', 
                    message: 'Discovery complete',
                    stats: phase2Result
                });
                
                logger.info(`Phase 2 complete: ${phase2Result.consolidated || 0} consolidated, ${phase2Result.patterns || 0} patterns, ${phase2Result.links || 0} links`);
            }
            
            // Final result
            const finalResult = {
                success: true,
                entityId,
                userId,
                ...results
            };
            
            publishProgress(1, finalResult, { phase: 'complete', message: 'Deep synthesis complete' });
            
            logger.info(`Deep synthesis complete for ${entityId}/${userId}`);
            
            return JSON.stringify(finalResult);
        } catch (error) {
            logger.error(`Deep synthesis failed for ${entityId}/${userId}: ${error.message}`);
            publishProgress(1, null, null, error.message);
            return JSON.stringify({
                success: false,
                error: error.message
            });
        }
    }
};

