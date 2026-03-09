'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * AgentSpawner — Spawns Claude Code CLI processes with cancel support.
 *
 * Builds a system prompt from the agent role template + plan body,
 * then runs `claude --print` as a child process.
 *
 * Active processes are tracked in a registry for cancel/status queries.
 *
 * Includes a post-agent safety net: if the agent exits without committing,
 * the spawner auto-commits and pushes any uncommitted changes.
 */

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// =============================================================================
// Process Registry — tracks active agent processes for cancel/status
// =============================================================================

/** @type {Map<string, { proc: ChildProcess, planId: string, agent: string, startedAt: string, turns: number, pid: number }>} */
const activeProcesses = new Map();

/**
 * Get a snapshot of all active agent processes.
 * @returns {Array<{ key: string, planId: string, agent: string, pid: number, startedAt: string, turns: number, uptimeSeconds: number }>}
 */
function getActiveAgents() {
    const now = Date.now();
    return [...activeProcesses.entries()].map(([key, info]) => ({
        key,
        planId: info.planId,
        agent: info.agent,
        pid: info.pid,
        startedAt: info.startedAt,
        turns: info.turns,
        uptimeSeconds: Math.round((now - new Date(info.startedAt).getTime()) / 1000),
    }));
}

/**
 * Cancel an active agent by key (planId/agentRole).
 * Sends SIGTERM, waits 5s, then SIGKILL if still alive.
 *
 * @param {string} key - Registry key (planId/agentRole)
 * @returns {{ cancelled: boolean, error: string|null }}
 */
function cancelAgent(key) {
    const entry = activeProcesses.get(key);
    if (!entry) {
        return { cancelled: false, error: `No active agent with key "${key}"` };
    }

    const { proc, agent, planId } = entry;
    console.warn(`[AgentSpawner] Cancelling ${agent} (plan: ${planId}, PID: ${proc.pid})`);

    try {
        proc.kill('SIGTERM');
    } catch (err) {
        return { cancelled: false, error: `SIGTERM failed: ${err.message}` };
    }

    // Force-kill after 5s if still alive
    setTimeout(() => {
        try {
            if (!proc.killed) {
                console.warn(`[AgentSpawner] Force-killing ${agent} (PID: ${proc.pid})`);
                proc.kill('SIGKILL');
            }
        } catch {
            // Already dead — fine
        }
    }, 5000);

    return { cancelled: true, error: null };
}

/**
 * Build the clean child environment for spawned agents.
 * Uses CLAUDE_API_KEY if set, otherwise removes ANTHROPIC_API_KEY
 * to force OAuth fallback via ~/.claude/.credentials.json.
 */
function buildChildEnv() {
    const childEnv = { ...process.env };
    // Always remove base URL overrides — agents must hit Anthropic directly
    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    if (process.env.CLAUDE_API_KEY) {
        childEnv.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
        return { childEnv, authMethod: 'api-key' };
    }
    delete childEnv.ANTHROPIC_API_KEY;
    return { childEnv, authMethod: 'oauth' };
}

/**
 * Pre-flight auth check — runs a trivial `claude --print` call to verify
 * credentials work before spending time on a real agent spawn.
 * Also warms the OAuth token refresh if needed.
 *
 * @param {string} claudePath - Path to claude CLI
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
function preflightAuth(claudePath = 'claude') {
    return new Promise((resolve) => {
        const { childEnv, authMethod } = buildChildEnv();
        const resolvedPath = (() => {
            try { return execSync(`which ${claudePath}`, { env: childEnv, timeout: 5000 }).toString().trim(); }
            catch { return claudePath; }
        })();
        console.log(`[AgentSpawner] Pre-flight auth check (${authMethod}, binary: ${resolvedPath})...`);

        const proc = spawn(resolvedPath, [
            '--print', '--dangerously-skip-permissions',
            '--max-turns', '1', '--output-format', 'json',
            '--tools', 'Bash',
            '--', 'Reply with exactly: AUTH_OK',
        ], {
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60000,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code, signal) => {
            if (code === 0 && stdout.includes('AUTH_OK')) {
                console.log(`[AgentSpawner] Pre-flight: auth OK (${authMethod})`);
                resolve({ ok: true, error: null });
            } else {
                const stderrTail = stderr.trim().split('\n').slice(-5).join('\n');
                const errMsg = `Pre-flight auth failed (code=${code}, signal=${signal}, method=${authMethod})`;
                console.error(`[AgentSpawner] ${errMsg}`);
                if (stderrTail) console.error(`[AgentSpawner] stderr: ${stderrTail}`);
                if (stdout.trim()) console.error(`[AgentSpawner] stdout: ${stdout.trim().slice(0, 500)}`);
                resolve({ ok: false, error: errMsg });
            }
        });

        proc.on('error', (err) => {
            console.error(`[AgentSpawner] Pre-flight spawn error: ${err.code || err.message}`);
            resolve({ ok: false, error: `spawn error: ${err.message}` });
        });
    });
}

// Appended to every agent prompt to ensure work gets committed
const COMMIT_DIRECTIVE = `

## CRITICAL: Git Workflow (MANDATORY)

Before you finish, you MUST commit and push your work. This is non-negotiable.

1. You are already on the correct branch. Do NOT checkout a different branch.
   Run \`git branch\` to confirm your current branch name.

2. Stage your new and modified files:
   \`git add <specific files you created or modified>\`

3. Commit with a descriptive message:
   \`git commit -m "feat: <concise summary of what you implemented>"\`

4. Push to the remote (use the current branch name):
   \`git push -u origin HEAD\`

If you do not commit and push, YOUR WORK WILL BE LOST when this session ends.
Do NOT end your response without confirming that the commit and push succeeded.
The daemon will create a PR automatically after you finish — do NOT create a PR yourself.
`;

/**
 * Check for uncommitted changes and auto-commit as a safety net.
 * Called after the agent process exits, before worktree teardown.
 *
 * @param {string} workingDir - Directory to check
 * @param {string} branch - Target branch name
 * @param {string} planTitle - Plan title for commit message
 * @returns {{ committed: boolean, pushed: boolean, error: string|null }}
 */
function ensureCommitted(workingDir, branch, planTitle) {
    try {
        // Check for uncommitted changes
        const status = execSync('git status --porcelain', {
            cwd: workingDir, timeout: 10000, stdio: 'pipe',
        }).toString().trim();

        if (!status) {
            console.log('[AgentSpawner] Safety net: working tree clean, no auto-commit needed');
            return { committed: false, pushed: false, error: null };
        }

        console.warn(`[AgentSpawner] Safety net: found uncommitted changes, auto-committing...`);
        console.warn(`[AgentSpawner] Dirty files:\n${status}`);

        // Ensure we're on the correct branch
        try {
            execSync(`git checkout "${branch}" 2>/dev/null || git checkout -b "${branch}"`, {
                cwd: workingDir, timeout: 15000, stdio: 'pipe',
            });
        } catch (branchErr) {
            console.warn(`[AgentSpawner] Branch checkout warning: ${branchErr.message}`);
        }

        // Stage all changes (new + modified + deleted)
        execSync('git add -A', {
            cwd: workingDir, timeout: 10000, stdio: 'pipe',
        });

        // Commit
        const commitMsg = `auto-commit: ${planTitle}\n\nBridge Daemon safety net — agent exited without committing.`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
            cwd: workingDir, timeout: 15000, stdio: 'pipe',
        });
        console.log('[AgentSpawner] Safety net: auto-commit created');

        // Push
        try {
            execSync(`git push -u origin "${branch}"`, {
                cwd: workingDir, timeout: 30000, stdio: 'pipe',
            });
            console.log(`[AgentSpawner] Safety net: pushed to origin/${branch}`);
            return { committed: true, pushed: true, error: null };
        } catch (pushErr) {
            console.warn(`[AgentSpawner] Safety net: push failed (commit preserved locally): ${pushErr.message}`);
            return { committed: true, pushed: false, error: pushErr.message };
        }
    } catch (err) {
        console.error(`[AgentSpawner] Safety net error: ${err.message}`);
        return { committed: false, pushed: false, error: err.message };
    }
}

/**
 * Spawn a Claude Code agent for a plan.
 *
 * @param {Object} plan - Parsed plan { frontmatter, body }
 * @param {string} workingDir - Working directory for the agent
 * @param {Object} teamMember - Team member object { agent, scope, blocked_files }
 * @param {Object} [options]
 * @param {number} [options.maxTurns=50]
 * @param {string} [options.claudePath='claude']
 * @returns {Promise<{ success: boolean, output: string, error: string|null, sessionId: string|null, safetyNet: object|null }>}
 */
async function spawnAgent(plan, workingDir, teamMember, options = {}) {
    const maxTurns = options.maxTurns || plan.frontmatter.max_turns_per_agent || 50;
    const claudePath = options.claudePath || 'claude';

    const agent = teamMember;
    const agentRole = agent.agent;

    // Build the system prompt
    const rolePromptPath = path.join(PROMPTS_DIR, `${agentRole}.md`);
    let rolePrompt = '';
    if (fs.existsSync(rolePromptPath)) {
        rolePrompt = fs.readFileSync(rolePromptPath, 'utf-8');
    } else {
        rolePrompt = `You are a ${agentRole} agent. Follow the plan instructions carefully.`;
    }

    // Construct the full prompt: role context + plan body + scope constraints + commit directive
    // NOTE: --system-prompt is NOT used because it triggers a Claude Code CLI bug
    // where prompts containing "/api/" path patterns cause infinite hangs.
    // Instead, the role prompt is prepended to the user message.
    const scopeConstraint = agent.scope?.length
        ? `\n\nYour scope is limited to these paths: ${agent.scope.join(', ')}`
        : '';

    const blockedConstraint = agent.blocked_files?.length
        ? `\nDo NOT modify these files: ${agent.blocked_files.join(', ')}`
        : '';

    const fullPrompt = [
        '## Your Role\n' + rolePrompt,
        '\n---\n## Your Task\n' + plan.body,
        scopeConstraint,
        blockedConstraint,
        `\nBranch: ${plan.frontmatter.branch}`,
        `Plan ID: ${plan.frontmatter.id}`,
        COMMIT_DIRECTIVE,
    ].join('\n');

    // Pre-flight auth check (warms OAuth token refresh if needed)
    const preflight = await preflightAuth(claudePath);
    if (!preflight.ok) {
        console.error(`[AgentSpawner] Aborting ${agentRole}: ${preflight.error}`);
        return {
            success: false,
            output: '',
            error: preflight.error,
            sessionId: null,
            safetyNet: null,
        };
    }

    return new Promise((resolve) => {
        console.log(`[AgentSpawner] Spawning ${agentRole} in ${workingDir}`);
        console.log(`[AgentSpawner] Max turns: ${maxTurns}`);

        const args = [
            '--print',
            '--dangerously-skip-permissions',
            '--max-turns', String(maxTurns),
            '--output-format', 'json',
            '--tools', 'Bash,Edit,Read,Write,Glob,Grep',
            '--', fullPrompt,
        ];

        const { childEnv, authMethod } = buildChildEnv();
        console.log(`[AgentSpawner] Auth method: ${authMethod}`);

        const proc = spawn(claudePath, args, {
            cwd: workingDir,
            env: childEnv,
            // stdin must be 'ignore' — Claude Code waits for stdin EOF before
            // processing when it detects a pipe. Since the prompt is passed as
            // a CLI argument, stdin is not needed.
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 600000, // 10-minute hard timeout
        });

        // Register in process registry for cancel/status
        const registryKey = `${plan.frontmatter.id}/${agentRole}`;
        const registryEntry = {
            proc,
            planId: plan.frontmatter.id,
            agent: agentRole,
            startedAt: new Date().toISOString(),
            turns: 0,
            pid: proc.pid,
        };
        activeProcesses.set(registryKey, registryEntry);

        let stdout = '';
        let stderr = '';
        let lastActivity = Date.now();
        let turnCount = 0;

        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            lastActivity = Date.now();

            // Stream meaningful lines to console for visibility
            for (const line of chunk.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Count turns from JSON output
                if (trimmed.includes('"type":"assistant"')) {
                    turnCount++;
                    registryEntry.turns = turnCount;
                }
                // Log tool use and key events
                if (trimmed.includes('"tool_use"') || trimmed.includes('"type":"result"')) {
                    console.log(`[Agent:${agentRole}] Turn ${turnCount}: ${trimmed.slice(0, 200)}`);
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            lastActivity = Date.now();
            // Stream stderr lines (Claude Code progress messages)
            for (const line of chunk.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) console.log(`[Agent:${agentRole}:err] ${trimmed.slice(0, 300)}`);
            }
        });

        // Heartbeat: log every 30s so you know it's alive
        const heartbeat = setInterval(() => {
            const elapsed = Math.round((Date.now() - lastActivity) / 1000);
            console.log(`[Agent:${agentRole}] Heartbeat — turns: ${turnCount}, idle: ${elapsed}s`);
        }, 30000);

        proc.on('close', (code) => {
            clearInterval(heartbeat);
            activeProcesses.delete(registryKey);
            console.log(`[AgentSpawner] ${agentRole} exited with code ${code} (${turnCount} turns)`);

            // Try to parse JSON output
            let sessionId = null;
            try {
                const parsed = JSON.parse(stdout);
                sessionId = parsed.session_id || null;
            } catch {
                // Output may not be valid JSON
            }

            // Safety net: auto-commit if agent left uncommitted changes
            const safetyNet = ensureCommitted(
                workingDir,
                plan.frontmatter.branch,
                plan.frontmatter.title
            );

            resolve({
                success: code === 0,
                output: stdout,
                error: code !== 0 ? (stderr || `Exit code ${code}`) : null,
                sessionId,
                safetyNet,
                turns: turnCount,
            });
        });

        proc.on('error', (err) => {
            console.error(`[AgentSpawner] Spawn error: ${err.message}`);
            resolve({
                success: false,
                output: '',
                error: err.message,
                sessionId: null,
            });
        });
    });
}

module.exports = { spawnAgent, ensureCommitted, preflightAuth, cancelAgent, getActiveAgents };
