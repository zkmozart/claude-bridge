'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ResultWriter — Generates results/<slug>.result.md from agent output.
 */

/**
 * Write a result file for a completed plan.
 * @param {string} resultsDir - Absolute path to results directory
 * @param {string} planId - Plan identifier
 * @param {Object} agentResult - { success, output, error, sessionId }
 * @param {Object} metadata - { frontmatter, startedAt, completedAt }
 * @returns {string} Path to the written result file
 */
function writeResult(resultsDir, planId, agentResult, metadata) {
    fs.mkdirSync(resultsDir, { recursive: true });

    const filePath = path.join(resultsDir, `${planId}.result.md`);
    const status = agentResult.success ? 'completed' : 'failed';
    const duration = metadata.completedAt && metadata.startedAt
        ? `${((new Date(metadata.completedAt) - new Date(metadata.startedAt)) / 1000).toFixed(1)}s`
        : 'unknown';

    const content = `---
plan_id: ${planId}
title: ${metadata.frontmatter?.title || planId}
status: ${status}
agent: ${metadata.frontmatter?.team?.[0]?.agent || 'unknown'}
branch: ${metadata.frontmatter?.branch || 'unknown'}
started_at: ${metadata.startedAt || 'unknown'}
completed_at: ${metadata.completedAt || new Date().toISOString()}
duration: ${duration}
session_id: ${agentResult.sessionId || 'none'}
---

# Result: ${metadata.frontmatter?.title || planId}

## Status: ${status.toUpperCase()}

${agentResult.error ? `## Error\n\n\`\`\`\n${agentResult.error}\n\`\`\`\n` : ''}

## Agent Output

\`\`\`
${truncateOutput(agentResult.output, 5000)}
\`\`\`

## Plan Metadata

- **Priority:** ${metadata.frontmatter?.priority || 'unknown'}
- **Created by:** ${metadata.frontmatter?.created_by || 'unknown'}
- **Tags:** ${(metadata.frontmatter?.tags || []).join(', ') || 'none'}
`;

    fs.writeFileSync(filePath, content);
    console.log(`[ResultWriter] Wrote ${filePath}`);
    return filePath;
}

function truncateOutput(output, maxLen) {
    if (!output) return '(no output)';
    if (output.length <= maxLen) return output;
    return output.slice(0, maxLen) + `\n\n... (truncated, ${output.length} total chars)`;
}

/**
 * Write a result file for a multi-agent plan.
 * @param {string} resultsDir - Absolute path to results directory
 * @param {string} planId - Plan identifier
 * @param {Object[]} agentResults - Array of { agent, success, output, error, sessionId, startedAt, completedAt, prUrl }
 * @param {Object} metadata - { frontmatter, startedAt, completedAt }
 * @returns {string} Path to the written result file
 */
function writeTeamResult(resultsDir, planId, agentResults, metadata) {
    fs.mkdirSync(resultsDir, { recursive: true });

    const filePath = path.join(resultsDir, `${planId}.result.md`);
    const allSuccess = agentResults.every(r => r.success);
    const anySuccess = agentResults.some(r => r.success);
    const overallStatus = allSuccess ? 'completed' : anySuccess ? 'partial' : 'failed';
    const duration = metadata.completedAt && metadata.startedAt
        ? `${((new Date(metadata.completedAt) - new Date(metadata.startedAt)) / 1000).toFixed(1)}s`
        : 'unknown';
    const agentNames = agentResults.map(r => r.agent).join(', ');

    const sections = agentResults.map((r) => {
        const agentDuration = r.completedAt && r.startedAt
            ? `${((new Date(r.completedAt) - new Date(r.startedAt)) / 1000).toFixed(1)}s`
            : 'unknown';
        const status = r.success ? 'COMPLETED' : 'FAILED';
        return `### ${r.agent}: ${status} (${agentDuration})

${r.error ? `**Error:**\n\`\`\`\n${r.error}\n\`\`\`\n` : ''}
**Session:** ${r.sessionId || 'none'}
**PR:** ${r.prUrl || 'none'}

<details>
<summary>Agent Output</summary>

\`\`\`
${truncateOutput(r.output, 3000)}
\`\`\`

</details>
`;
    }).join('\n');

    const content = `---
plan_id: ${planId}
title: ${metadata.frontmatter?.title || planId}
status: ${overallStatus}
agents: ${agentNames}
branch: ${metadata.frontmatter?.branch || 'unknown'}
started_at: ${metadata.startedAt || 'unknown'}
completed_at: ${metadata.completedAt || new Date().toISOString()}
duration: ${duration}
---

# Result: ${metadata.frontmatter?.title || planId}

## Status: ${overallStatus.toUpperCase()} (${agentResults.filter(r => r.success).length}/${agentResults.length} agents succeeded)

## Agent Results

${sections}
## Plan Metadata

- **Priority:** ${metadata.frontmatter?.priority || 'unknown'}
- **Created by:** ${metadata.frontmatter?.created_by || 'unknown'}
- **Tags:** ${(metadata.frontmatter?.tags || []).join(', ') || 'none'}
`;

    fs.writeFileSync(filePath, content);
    console.log(`[ResultWriter] Wrote team result: ${filePath}`);
    return filePath;
}

module.exports = { writeResult, writeTeamResult };
