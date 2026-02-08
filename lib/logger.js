// logger.js
import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

winston.addColors({
    debug: 'green',
    verbose: 'blue',
    http: 'gray',
    info: 'cyan',
    warn: 'yellow',
    error: 'red'
});

const debugFormat = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.cli()
);

const prodFormat = winston.format.combine(
    winston.format.simple()
);

// AsyncLocalStorage to track per-request logging suppression
const loggingContext = new AsyncLocalStorage();

// Check if continuity-only logging mode is enabled
const isContinuityMode = () => process.env.CORTEX_LOG_MODE === 'continuity';

// Winston format that drops non-error logs when suppression is enabled in the current async context
// In continuity mode, drops ALL non-continuity logs
const suppressNonErrorFormat = winston.format((info) => {
    const store = loggingContext.getStore();
    if (store && store.suppressNonErrorLogs === true && info.level !== 'error') {
        return false; // drop this log entry
    }
    // In continuity mode, suppress all regular logs (continuity logs go through dedicated logger)
    if (isContinuityMode()) {
        return false;
    }
    return info; // keep
});

const getTransport = () => {
    switch (process.env.NODE_ENV) {
      case 'production':
        return new winston.transports.Console({ level: 'info', format: winston.format.combine(suppressNonErrorFormat(), prodFormat) });
      case 'development':
        return new winston.transports.Console({ level: 'verbose', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
      case 'debug':
      case 'test':
        return new winston.transports.Console({ level: 'debug', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
      default:
        // Default to development settings if NODE_ENV is not set or unknown
        console.warn(`Unknown NODE_ENV: ${process.env.NODE_ENV}. Defaulting to development settings.`);
        return new winston.transports.Console({ level: 'verbose', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
    }
};

// Create the logger
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 
           process.env.NODE_ENV === 'debug' ? 'debug' : 'verbose',
    transports: [getTransport()]
});

// ==================== CONTINUITY LOGGER ====================
// A dedicated logger for continuity memory operations
// Enable with: CORTEX_LOG_MODE=continuity

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
    white: '\x1b[37m'
};

const continuityLog = {
    /**
     * Log a context block being sent to the agent
     * @param {string} entityId 
     * @param {string} userId 
     * @param {string} contextBlock - The full context string
     * @param {Object} meta - Optional metadata (memoryCounts, etc.)
     */
    contextBlock(entityId, userId, contextBlock, meta = {}) {
        if (!isContinuityMode()) return;
        
        const timestamp = new Date().toISOString().substring(11, 19);
        const header = `${COLORS.cyan}${COLORS.bold}━━━ CONTEXT BLOCK ━━━${COLORS.reset} ${COLORS.dim}[${timestamp}] ${entityId}/${userId}${COLORS.reset}`;
        
        console.log('\n' + header);
        
        // Show memory counts if available
        if (meta.memoryCounts) {
            const counts = Object.entries(meta.memoryCounts)
                .filter(([, count]) => count > 0)
                .map(([type, count]) => `${type}:${count}`)
                .join(' ');
            if (counts) {
                console.log(`${COLORS.dim}Memories: ${counts}${COLORS.reset}`);
            }
        }
        
        // Print the context block with visual formatting
        console.log(`${COLORS.gray}┌${'─'.repeat(70)}${COLORS.reset}`);
        const lines = contextBlock.split('\n');
        for (const line of lines) {
            // Highlight section headers
            if (line.startsWith('## ')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.yellow}${COLORS.bold}${line}${COLORS.reset}`);
            } else if (line.startsWith('### ')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.magenta}${line}${COLORS.reset}`);
            } else if (line.startsWith('- ') || line.startsWith('* ')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.white}${line}${COLORS.reset}`);
            } else {
                console.log(`${COLORS.gray}│${COLORS.reset} ${line}`);
            }
        }
        console.log(`${COLORS.gray}└${'─'.repeat(70)}${COLORS.reset}\n`);
    },
    
    /**
     * Log a turn being recorded
     * @param {string} entityId 
     * @param {string} userId 
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message content (truncated for display)
     */
    recordTurn(entityId, userId, role, content) {
        if (!isContinuityMode()) return;
        
        const timestamp = new Date().toISOString().substring(11, 19);
        const roleIcon = role === 'user' ? '👤' : '🤖';
        const roleColor = role === 'user' ? COLORS.blue : COLORS.green;
        const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
        
        console.log(`${COLORS.dim}[${timestamp}]${COLORS.reset} ${roleIcon} ${roleColor}RECORD${COLORS.reset} ${COLORS.dim}${entityId}/${userId}${COLORS.reset}`);
        console.log(`  ${COLORS.dim}└─${COLORS.reset} "${preview}"`);
    },
    
    /**
     * Log synthesis action
     * @param {string} action - 'turn_synthesis', 'compass_synthesis', 'deep_synthesis', etc.
     * @param {string} entityId 
     * @param {string} userId 
     * @param {Object} result - Action result/stats
     */
    synthesize(action, entityId, userId, result = {}) {
        if (!isContinuityMode()) return;
        
        const timestamp = new Date().toISOString().substring(11, 19);
        const actionMap = {
            'turn_synthesis': { icon: '⚡', label: 'TURN SYNTHESIS', color: COLORS.yellow },
            'compass_synthesis': { icon: '🧭', label: 'COMPASS UPDATE', color: COLORS.magenta },
            'deep_synthesis': { icon: '🔮', label: 'DEEP SYNTHESIS', color: COLORS.cyan },
            'session_init': { icon: '🚀', label: 'SESSION INIT', color: COLORS.green },
            'session_end': { icon: '🌙', label: 'SESSION END', color: COLORS.blue },
            'memory_store': { icon: '💾', label: 'STORE MEMORY', color: COLORS.green },
            'memory_merge': { icon: '🔗', label: 'MERGE MEMORY', color: COLORS.yellow }
        };
        
        const config = actionMap[action] || { icon: '📝', label: action.toUpperCase(), color: COLORS.white };
        
        console.log(`${COLORS.dim}[${timestamp}]${COLORS.reset} ${config.icon} ${config.color}${config.label}${COLORS.reset} ${COLORS.dim}${entityId}/${userId}${COLORS.reset}`);
        
        // Show relevant result details
        if (result.newMemories !== undefined) {
            console.log(`  ${COLORS.dim}└─${COLORS.reset} ${result.newMemories} new memories`);
        }
        if (result.content) {
            const preview = result.content.length > 100 ? result.content.substring(0, 100) + '...' : result.content;
            console.log(`  ${COLORS.dim}└─${COLORS.reset} "${preview}"`);
        }
        if (result.vibe) {
            console.log(`  ${COLORS.dim}└─ Vibe:${COLORS.reset} ${result.vibe}`);
        }
        if (result.currentFocus && result.currentFocus.length > 0) {
            console.log(`  ${COLORS.dim}└─ Current focus:${COLORS.reset} ${result.currentFocus.length}`);
        }
        if (result.stats) {
            const statsStr = Object.entries(result.stats)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${k}:${v}`)
                .join(' ');
            if (statsStr) {
                console.log(`  ${COLORS.dim}└─${COLORS.reset} ${statsStr}`);
            }
        }
    },
    
    /**
     * Log Internal Compass content
     * @param {string} entityId 
     * @param {string} userId 
     * @param {Object} compass - The compass object with content
     */
    compass(entityId, userId, compass) {
        if (!isContinuityMode() || !compass?.content) return;
        
        const timestamp = new Date().toISOString().substring(11, 19);
        console.log(`\n${COLORS.magenta}${COLORS.bold}━━━ INTERNAL COMPASS ━━━${COLORS.reset} ${COLORS.dim}[${timestamp}] ${entityId}/${userId}${COLORS.reset}`);
        console.log(`${COLORS.gray}┌${'─'.repeat(60)}${COLORS.reset}`);
        
        const lines = compass.content.split('\n');
        for (const line of lines) {
            if (line.toLowerCase().includes('vibe:')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.yellow}${line}${COLORS.reset}`);
            } else if (line.toLowerCase().includes('recent topics:')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.blue}${COLORS.bold}${line}${COLORS.reset}`);
            } else if (/^\d+\.\s/.test(line.trim())) {
                // Numbered topic list items
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.blue}${line}${COLORS.reset}`);
            } else if (line.toLowerCase().includes('recent story:') || line.toLowerCase().includes('story:')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.cyan}${line}${COLORS.reset}`);
            } else if (line.toLowerCase().includes('current focus') || line.startsWith('- ')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.green}${line}${COLORS.reset}`);
            } else if (line.toLowerCase().includes('my note') || line.toLowerCase().includes('note:')) {
                console.log(`${COLORS.gray}│${COLORS.reset} ${COLORS.magenta}${line}${COLORS.reset}`);
            } else {
                console.log(`${COLORS.gray}│${COLORS.reset} ${line}`);
            }
        }
        console.log(`${COLORS.gray}└${'─'.repeat(60)}${COLORS.reset}\n`);
    }
};

export { continuityLog };

// Function to obscure sensitive URL parameters
export const obscureUrlParams = url => {
    try {
        const urlObject = new URL(url);
        urlObject.searchParams.forEach((value, name) => {
            if (/token|key|password|secret|auth|apikey|access|passwd|credential/i.test(name)) {
                urlObject.searchParams.set(name, '******');
            }
        });
        return urlObject.toString();
    } catch (e) {
        if (e instanceof TypeError) {
            logger.error('Error obscuring URL parameters - invalid URL.');
            return url;
        } else {
            throw e;
        }
    }
};

// Run a function with non-error logs suppressed for the current async execution context
export const withRequestLoggingDisabled = fn => loggingContext.run({ suppressNonErrorLogs: true }, fn);

export default logger;