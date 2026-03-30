#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const DEFAULTS = {
    report: '/tmp/gpt54-taxonomy-style-fingerprint-reclassified.json',
    mdOut: '',
    csvOut: '',
};

function parseArgs(argv) {
    const args = { ...DEFAULTS };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = argv[index + 1];

        if (token === '--report' && next) {
            args.report = next;
            index += 1;
        } else if (token.startsWith('--report=')) {
            args.report = token.split('=').slice(1).join('=');
        } else if (token === '--md-out' && next) {
            args.mdOut = next;
            index += 1;
        } else if (token.startsWith('--md-out=')) {
            args.mdOut = token.split('=').slice(1).join('=');
        } else if (token === '--csv-out' && next) {
            args.csvOut = next;
            index += 1;
        } else if (token.startsWith('--csv-out=')) {
            args.csvOut = token.split('=').slice(1).join('=');
        }
    }

    return args;
}

function groupCounts(items, getter) {
    const counts = new Map();

    for (const item of items) {
        const key = getter(item);
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, count]) => ({ key, count }));
}

function summarizeArtifacts(queue) {
    return groupCounts(
        queue.flatMap(item => item.artifacts.map(artifact => `${artifact.artifact} | ${artifact.reason}`)),
        value => value
    );
}

function sanitizeFence(text) {
    return String(text || '').replace(/```/g, '``` ');
}

function escapeTableCell(text) {
    return String(text || '').replace(/\|/g, '\\|');
}

function uniqueArtifactNames(artifacts) {
    return [...new Set(artifacts.map(artifact => artifact.artifact))]
        .filter(name => !name.includes(' vs '));
}

function buildMarkdown(report) {
    const queue = report.verificationQueue || [];
    const promptCounts = groupCounts(queue, item => item.promptName);
    const artifactCounts = summarizeArtifacts(queue);

    const lines = [
        '# Style Review Worksheet',
        '',
        `Source report: \`${report.model || 'unknown model'}\``,
        `Generated from: \`${report.generatedAt || 'unknown'}\``,
        `Reclassified at: \`${report.reclassifiedAt || 'unknown'}\``,
        '',
        `Total queued runs: **${queue.length}**`,
        '',
        '## Prompt Counts',
        '',
        '| Prompt | Count |',
        '| --- | ---: |',
        ...promptCounts.map(item => `| ${escapeTableCell(item.key)} | ${item.count} |`),
        '',
        '## Review Reasons',
        '',
        '| Artifact / Reason | Count |',
        '| --- | ---: |',
        ...artifactCounts.map(item => `| ${escapeTableCell(item.key)} | ${item.count} |`),
        '',
        '## Reviewer Instructions',
        '',
        '- For each run, mark whether each flagged artifact is truly present.',
        '- If the run has a mixed dominant signal, choose the better dominant artifact.',
        '- Add short notes only when the heuristic is clearly wrong or the behavior is ambiguous.',
        '- Keep labels tied to the glossary terms.',
        '',
    ];

    queue.forEach((item, index) => {
        const distinctArtifacts = uniqueArtifactNames(item.artifacts);
        const mixedSignal = item.artifacts.find(artifact => artifact.artifact.includes(' vs '));

        lines.push(`## ${index + 1}. ${item.promptName} (repeat ${item.repeat})`);
        lines.push('');
        lines.push(`- Suggested dominant trait: \`${item.dominantTrait}\``);
        lines.push('- Flagged artifacts:');
        item.artifacts.forEach(artifact => {
            lines.push(`  - \`${artifact.artifact}\` score=${artifact.score} reason=${artifact.reason}`);
        });
        lines.push('');
        lines.push('Reviewer labels:');
        distinctArtifacts.forEach(name => {
            lines.push(`- \`${name}\`: [ ] yes [ ] no`);
        });
        if (mixedSignal) {
            const fallbackTraits = ['structural_bias', 'verbosity_bias', 'continuation_bias', 'formatting_bias']
                .filter(name => name !== item.dominantTrait)
                .map(name => `[ ] ${name}`)
                .join(' ');
            lines.push(`- Dominant trait: [ ] keep \`${item.dominantTrait}\` ${fallbackTraits} [ ] other: ___`);
        }
        lines.push('- Notes: ___');
        lines.push('');
        lines.push('Response:');
        lines.push('');
        lines.push('```text');
        lines.push(sanitizeFence(item.response));
        lines.push('```');
        lines.push('');
    });

    return lines.join('\n');
}

function csvEscape(value) {
    const stringValue = String(value ?? '');
    return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildCsv(report) {
    const queue = report.verificationQueue || [];
    const header = [
        'row_id',
        'prompt_name',
        'repeat',
        'dominant_trait',
        'artifact',
        'score',
        'reason',
        'response',
    ];
    const rows = [header.join(',')];

    queue.forEach((item, index) => {
        item.artifacts.forEach(artifact => {
            rows.push([
                csvEscape(index + 1),
                csvEscape(item.promptName),
                csvEscape(item.repeat),
                csvEscape(item.dominantTrait),
                csvEscape(artifact.artifact),
                csvEscape(artifact.score),
                csvEscape(artifact.reason),
                csvEscape(item.response),
            ].join(','));
        });
    });

    return rows.join('\n');
}

async function writeFileIfRequested(outputPath, content) {
    if (!outputPath) {
        return;
    }

    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
    console.log(`Wrote ${resolved}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(await fs.readFile(path.resolve(args.report), 'utf8'));

    if (!args.mdOut && !args.csvOut) {
        throw new Error('Specify at least one output: --md-out or --csv-out');
    }

    if (args.mdOut) {
        await writeFileIfRequested(args.mdOut, buildMarkdown(report));
    }

    if (args.csvOut) {
        await writeFileIfRequested(args.csvOut, buildCsv(report));
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
