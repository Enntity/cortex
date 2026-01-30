import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listBackgroundJobs } from './shell.js';

const startedAt = Date.now();

/**
 * Get system status: disk, memory, CPU, uptime, processes, background jobs.
 */
export async function getStatus() {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memory = {
        totalMB: Math.round(totalMem / 1024 / 1024),
        freeMB: Math.round(freeMem / 1024 / 1024),
        usedMB: Math.round((totalMem - freeMem) / 1024 / 1024),
        usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    };

    // CPU load
    const loadAvg = os.loadavg();
    const cpu = {
        cores: os.cpus().length,
        loadAvg1m: loadAvg[0],
        loadAvg5m: loadAvg[1],
        loadAvg15m: loadAvg[2],
    };

    // Disk usage for /workspace
    let disk = {};
    try {
        const dfOutput = execSync('df -B1 /workspace 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 5000 });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
            const total = parseInt(parts[1], 10);
            const used = parseInt(parts[2], 10);
            const available = parseInt(parts[3], 10);
            disk = {
                totalMB: Math.round(total / 1024 / 1024),
                usedMB: Math.round(used / 1024 / 1024),
                availableMB: Math.round(available / 1024 / 1024),
                usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
            };
        }
    } catch {
        disk = { error: 'Unable to read disk info' };
    }

    // Running processes
    let processes = [];
    try {
        const psOutput = execSync('ps aux --sort=-%mem 2>/dev/null | head -11', { encoding: 'utf8', timeout: 5000 });
        const lines = psOutput.trim().split('\n');
        // Skip header, parse top 10
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length >= 11) {
                processes.push({
                    user: parts[0],
                    pid: parseInt(parts[1], 10),
                    cpu: parseFloat(parts[2]),
                    mem: parseFloat(parts[3]),
                    command: parts.slice(10).join(' ').slice(0, 100),
                });
            }
        }
    } catch {
        // ps not available
    }

    return {
        uptime,
        memory,
        cpu,
        disk,
        processes,
        backgroundJobs: listBackgroundJobs(),
    };
}

/**
 * Create a tarball backup of /workspace.
 * Returns the path and size of the created archive.
 */
export async function createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `/tmp/workspace-backup-${timestamp}.tar.gz`;

    try {
        execSync(
            `tar czf "${backupPath}" -C /workspace .`,
            { encoding: 'utf8', timeout: 120000 }
        );

        const stat = await fs.stat(backupPath);
        return {
            path: backupPath,
            sizeBytes: stat.size,
            sizeMB: Math.round(stat.size / 1024 / 1024 * 100) / 100,
            timestamp,
        };
    } catch (e) {
        return { error: `Backup failed: ${e.message}` };
    }
}

/**
 * Restore workspace from a tarball at the given path.
 */
export async function restoreBackup(archivePath) {
    try {
        const stat = await fs.stat(archivePath);
        if (!stat.isFile()) {
            return { error: `Not a file: ${archivePath}` };
        }

        // Extract to /workspace (overwrites existing files)
        execSync(
            `tar xzf "${archivePath}" -C /workspace`,
            { encoding: 'utf8', timeout: 120000 }
        );

        return {
            message: 'Workspace restored from backup',
            archivePath,
            sizeBytes: stat.size,
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { error: `Archive not found: ${archivePath}` };
        return { error: `Restore failed: ${e.message}` };
    }
}

/**
 * Reset workspace: wipe /workspace except preserved paths.
 */
export async function resetWorkspace(preservePaths = []) {
    const workspaceDir = '/workspace';

    const preserveSet = new Set(preservePaths.map(p => p.replace(/^\/workspace\/?/, '').replace(/\/$/, '')));

    try {
        const entries = await fs.readdir(workspaceDir);
        let removed = 0;

        for (const entry of entries) {
            if (preserveSet.has(entry)) continue;
            const fullPath = `${workspaceDir}/${entry}`;
            await fs.rm(fullPath, { recursive: true, force: true });
            removed++;
        }

        return {
            message: `Workspace reset. Removed ${removed} items.`,
            preservedPaths: [...preserveSet],
        };
    } catch (e) {
        return { error: `Failed to reset workspace: ${e.message}` };
    }
}
