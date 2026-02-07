#!/usr/bin/env node

/**
 * cortex-claude-code helper app
 *
 * Long-polls the Cortex GraphQL API for code help requests queued by
 * entities (via RequestCodeHelp), spawns `claude` CLI to process them,
 * and reports results back (via sys_dequeue_code_help).
 *
 * No npm dependencies — uses native fetch and child_process.
 *
 * Usage:
 *   CORTEX_API_KEY=your-key node index.js
 *
 * Env vars:
 *   CORTEX_API_KEY  — required, Cortex API key
 *   CORTEX_URL      — GraphQL endpoint (default: https://api.enntity.com/graphql)
 *   PROJECT_DIR     — working directory for claude CLI (default: cwd)
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(__dirname, 'SYSTEM_PROMPT.md'), 'utf-8');
const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
const CORTEX_URL = process.env.CORTEX_URL || 'https://api.enntity.com/graphql';
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const FETCH_TIMEOUT_MS = 50_000; // must exceed BRPOP (30s) on server side
const RETRY_DELAY_MS = 5_000;

if (!CORTEX_API_KEY) {
    console.error('CORTEX_API_KEY is required');
    process.exit(1);
}

// ── GraphQL helpers ─────────────────────────────────────────────────

async function graphql(query, variables = {}) {
    const res = await fetch(CORTEX_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'cortex-api-key': CORTEX_API_KEY,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
        throw new Error(json.errors.map(e => e.message).join('; '));
    }
    return json.data;
}

// ── Dequeue a request ───────────────────────────────────────────────

async function dequeue() {
    const data = await graphql(`
        query {
            sys_dequeue_code_help(action: "dequeue")
        }
    `);

    const result = JSON.parse(data.sys_dequeue_code_help);
    return result.request || null;
}

// ── Report result back ──────────────────────────────────────────────

async function report(requestId, { status, summary, filesChanged, error }) {
    await graphql(`
        query($requestId: String!, $status: String!, $summary: String, $filesChanged: String, $error: String) {
            sys_dequeue_code_help(
                action: "report",
                requestId: $requestId,
                status: $status,
                summary: $summary,
                filesChanged: $filesChanged,
                error: $error
            )
        }
    `, { requestId, status, summary, filesChanged, error });
}

// ── Spawn claude CLI ────────────────────────────────────────────────

function buildPrompt(request) {
    const parts = [SYSTEM_PROMPT];
    parts.push(`\n---\n`);
    parts.push(`Code help request from ${request.entityName || 'an entity'}:`);
    parts.push(`\nIssue: ${request.issue}`);
    if (request.filePath) parts.push(`File: ${request.filePath}`);
    if (request.error) parts.push(`Error: ${request.error}`);
    if (request.context) parts.push(`Context: ${request.context}`);
    if (request.priority === 'urgent') parts.push(`\nPriority: URGENT`);
    parts.push(`\nInvestigate and fix this issue. Run relevant tests to verify. Then commit and push to main so CI/CD deploys it. Provide a concise summary of what you changed.`);
    return parts.join('\n');
}

function runClaude(prompt) {
    return new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', prompt, '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep'], {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || `claude exited with code ${code}`));
            }
        });

        child.on('error', reject);
    });
}

// ── Process a single request ────────────────────────────────────────

async function processRequest(request) {
    console.log(`\n→ Processing ${request.requestId} from ${request.entityName}`);
    console.log(`  Issue: ${request.issue}`);

    const prompt = buildPrompt(request);

    try {
        const output = await runClaude(prompt);

        // Truncate summary if excessively long
        const summary = output.length > 4000 ? output.substring(0, 4000) + '\n...(truncated)' : output;

        await report(request.requestId, {
            status: 'completed',
            summary,
            filesChanged: null,
            error: null,
        });

        console.log(`  ✓ Completed ${request.requestId}`);
    } catch (err) {
        console.error(`  ✗ Failed ${request.requestId}: ${err.message}`);

        await report(request.requestId, {
            status: 'error',
            summary: null,
            filesChanged: null,
            error: err.message.substring(0, 2000),
        }).catch(reportErr => {
            console.error(`  ✗ Failed to report error: ${reportErr.message}`);
        });
    }
}

// ── Main loop ───────────────────────────────────────────────────────

async function main() {
    console.log('cortex-claude-code helper');
    console.log(`  Cortex:  ${CORTEX_URL}`);
    console.log(`  Project: ${PROJECT_DIR}`);
    console.log('  Waiting for requests...\n');

    while (true) {
        try {
            const request = await dequeue();

            if (request) {
                await processRequest(request);
            }
            // If null (BRPOP timeout), just loop immediately
        } catch (err) {
            console.error(`Poll error: ${err.message}`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }
}

main();
