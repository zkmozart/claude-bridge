'use strict';

const { execSync } = require('child_process');
const path = require('path');

/**
 * WorktreeManager — Creates and tears down git worktrees for agent isolation.
 * Wraps the scripts/agent-worktree.sh script.
 */

/**
 * Create a worktree for an agent stream.
 * @param {string} repoPath - Absolute path to the repo root
 * @param {string} slug - Feature slug (e.g., "auth-refactor")
 * @param {string} stream - Workstream name (e.g., "backend")
 * @returns {string} Absolute path to the created worktree
 */
function createWorktree(repoPath, slug, stream) {
    const scriptPath = path.join(repoPath, 'scripts', 'agent-worktree.sh');

    try {
        const output = execSync(
            `bash "${scriptPath}" setup "${slug}" "${stream}"`,
            { cwd: repoPath, timeout: 30000, stdio: 'pipe' }
        ).toString();

        console.log(`[WorktreeManager] Created worktree: ${slug}-${stream}`);

        // Parse the worktree path from the script output or construct it
        const worktreeBase = path.join(path.dirname(repoPath), '.agent-worktrees');
        const worktreePath = path.join(worktreeBase, `${slug}-${stream}`);

        return worktreePath;
    } catch (err) {
        // Fallback: create a simple branch-based checkout without worktrees
        console.warn(`[WorktreeManager] Worktree script failed, using branch fallback: ${err.message}`);

        const branchName = `agent/${slug}-${stream}`;
        try {
            execSync(`git checkout -b "${branchName}" 2>/dev/null || git checkout "${branchName}"`, {
                cwd: repoPath,
                timeout: 15000,
                stdio: 'pipe',
            });
        } catch {
            // Branch may already exist
        }

        return repoPath;
    }
}

/**
 * Tear down a worktree for a feature slug.
 * @param {string} repoPath - Absolute path to the repo root
 * @param {string} slug - Feature slug to tear down
 */
function teardownWorktree(repoPath, slug) {
    const scriptPath = path.join(repoPath, 'scripts', 'agent-worktree.sh');

    try {
        execSync(
            `bash "${scriptPath}" teardown "${slug}"`,
            { cwd: repoPath, timeout: 30000, stdio: 'pipe' }
        );
        console.log(`[WorktreeManager] Torn down worktree: ${slug}`);
    } catch (err) {
        console.warn(`[WorktreeManager] Teardown failed (non-fatal): ${err.message}`);
    }
}

module.exports = { createWorktree, teardownWorktree };
