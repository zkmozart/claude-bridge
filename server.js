'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const StateManager = require('./lib/state-manager');
const PlanWatcher = require('./lib/plan-watcher');
const { createWorktree, teardownWorktree } = require('./lib/worktree-manager');
const { spawnAgent, preflightAuth, cancelAgent, getActiveAgents } = require('./lib/agent-spawner');
const { writeResult, writeTeamResult } = require('./lib/result-writer');
const { validatePlan } = require('./lib/plan-parser');
const authMiddleware = require('./lib/auth-middleware');
const bus = require('./lib/event-bus');

// =============================================================================
// Configuration
// =============================================================================

const configPath = path.join(__dirname, 'bridge.config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
    console.error(`[Bridge] Failed to load config: ${err.message}`);
    process.exit(1);
}

const PORT = process.env.PORT || 3100;
const REPO_PATH = process.env.REPO_PATH || config.repoPath;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || config.pollIntervalMs, 10);
const RESULTS_DIR = path.resolve(REPO_PATH, config.resultsDir);
const STATE_PATH = path.resolve(REPO_PATH, config.stateFile);

// =============================================================================
// Initialization
// =============================================================================

const stateManager = new StateManager(STATE_PATH);

const watcher = new PlanWatcher({
    repoPath: REPO_PATH,
    pollInterval: POLL_INTERVAL,
    stateManager,
    onNewPlan: handleNewPlan,
    maxConcurrentAgents: config.maxConcurrentAgents || 5,
});

/**
 * Create a pull request for a completed agent workstream.
 * Uses `gh pr create` — requires `gh` CLI and valid auth.
 */
function createPullRequest(slug, stream, frontmatter) {
    const agentBranch = `agent/${slug}-${stream}`;
    const title = frontmatter.title || slug;
    const body = [
        '## Summary',
        `Automated implementation of: **${title}**`,
        '',
        `- **Plan ID:** ${frontmatter.id}`,
        `- **Priority:** ${frontmatter.priority}`,
        `- **Agent:** ${stream}`,
        `- **Created by:** ${frontmatter.created_by || 'bridge-daemon'}`,
        '',
        `Built by Bridge Daemon agent.`,
    ].join('\n');

    try {
        const prUrl = execSync(
            `gh pr create --head "${agentBranch}" --base main --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
            { cwd: REPO_PATH, timeout: 30000, stdio: 'pipe' }
        ).toString().trim();
        console.log(`[Bridge] PR created: ${prUrl}`);
        return prUrl;
    } catch (err) {
        const stderr = err.stderr?.toString() || err.message;
        if (stderr.includes('already exists')) {
            console.log(`[Bridge] PR already exists for ${agentBranch}`);
            return 'already-exists';
        }
        console.error(`[Bridge] PR creation failed: ${stderr}`);
        return null;
    }
}

/**
 * Topological sort for team members based on depends_on.
 * Returns array of arrays (layers): members in the same layer can run in parallel.
 */
function buildExecutionLayers(team) {
    const byName = new Map(team.map(m => [m.agent, m]));
    const resolved = new Set();
    const layers = [];

    for (let i = 0; i < team.length; i++) {
        const layer = team.filter(m => {
            if (resolved.has(m.agent)) return false;
            const deps = m.depends_on || [];
            return deps.every(d => resolved.has(d));
        });
        if (layer.length === 0) break;
        layers.push(layer);
        layer.forEach(m => resolved.add(m.agent));
    }

    const unresolved = team.filter(m => !resolved.has(m.agent));
    if (unresolved.length > 0) {
        console.warn(`[Bridge] Unresolvable depends_on for: ${unresolved.map(m => m.agent).join(', ')} — running them last`);
        layers.push(unresolved);
    }

    return layers;
}

/**
 * Spawn a single agent within the team orchestrator.
 */
async function runTeamMember(slug, member, plan, agentOptions) {
    const stream = member.agent;
    const startedAt = new Date().toISOString();

    bus.agent('started', { planId: slug, agent: stream, status: 'running' });

    let workingDir;
    try {
        workingDir = createWorktree(REPO_PATH, slug, stream);
    } catch (err) {
        console.error(`[Bridge] Worktree creation failed for ${stream}: ${err.message}`);
        workingDir = REPO_PATH;
    }

    const result = await spawnAgent(plan, workingDir, member, agentOptions);
    const completedAt = new Date().toISOString();

    if (result.safetyNet?.committed) {
        console.warn(`[Bridge] Safety net triggered for ${slug}/${stream}`);
    }

    let prUrl = null;
    if (result.success) {
        prUrl = createPullRequest(slug, stream, plan.frontmatter);
    }

    const action = result.success ? 'completed' : 'failed';
    bus.agent(action, { planId: slug, agent: stream, prUrl, turns: result.turns || 0 });

    return {
        agent: stream,
        success: result.success,
        output: result.output,
        error: result.error,
        sessionId: result.sessionId,
        safetyNet: result.safetyNet,
        prUrl,
        startedAt,
        completedAt,
    };
}

/**
 * Handle a new plan detected by the watcher.
 * Multi-agent team orchestration with DAG-based execution layers.
 */
async function handleNewPlan({ planId, frontmatter, body }) {
    const startedAt = new Date().toISOString();
    const team = frontmatter.team || [];
    const slug = planId;

    console.log(`[Bridge] Processing plan: ${planId} (${frontmatter.title}) — ${team.length} agent(s)`);

    bus.plan('started', { planId, title: frontmatter.title, agents: team.map(m => m.agent), status: 'in-progress' });

    const plan = { frontmatter, body };
    const agentOptions = {
        maxTurns: frontmatter.max_turns_per_agent || config.defaultMaxTurns,
        claudePath: process.env.CLAUDE_CLI_PATH || 'claude',
    };

    const layers = buildExecutionLayers(team);
    console.log(`[Bridge] Execution layers: ${layers.map((l, i) => `L${i}=[${l.map(m => m.agent).join(',')}]`).join(' -> ')}`);

    const allResults = [];
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        console.log(`[Bridge] Starting layer ${i}: ${layer.map(m => m.agent).join(', ')}`);

        const layerResults = await Promise.all(
            layer.map(member => runTeamMember(slug, member, plan, agentOptions))
        );
        allResults.push(...layerResults);

        const failed = layerResults.filter(r => !r.success);
        if (failed.length > 0) {
            console.warn(`[Bridge] Layer ${i}: ${failed.length}/${layer.length} agent(s) failed: ${failed.map(r => r.agent).join(', ')}`);
        }
    }

    const completedAt = new Date().toISOString();

    const allSuccess = allResults.every(r => r.success);
    const anySuccess = allResults.some(r => r.success);
    const overallStatus = allSuccess ? 'completed' : anySuccess ? 'partial' : 'failed';

    const resultPath = writeTeamResult(RESULTS_DIR, planId, allResults, {
        frontmatter,
        startedAt,
        completedAt,
    });

    const agentResultMap = {};
    for (const r of allResults) {
        agentResultMap[r.agent] = {
            status: r.success ? 'completed' : 'failed',
            sessionId: r.sessionId,
            prUrl: r.prUrl,
            error: r.error,
        };
    }

    stateManager.markTeamProcessed(planId, overallStatus, agentResultMap, { resultPath });

    const hasUnpushed = allResults.some(r => r.safetyNet?.committed && !r.safetyNet?.pushed);
    if (hasUnpushed) {
        console.warn(`[Bridge] Skipping worktree teardown for ${planId} — unpushed auto-commit(s) preserved`);
    } else {
        try {
            teardownWorktree(REPO_PATH, slug);
        } catch {
            // Cleanup is best-effort
        }
    }

    bus.plan(overallStatus, { planId, title: frontmatter.title, agents: team.map(m => m.agent), status: overallStatus });

    console.log(`[Bridge] Plan ${planId}: ${overallStatus.toUpperCase()} — ${allResults.filter(r => r.success).length}/${allResults.length} agents succeeded (${resultPath})`);
}

// =============================================================================
// Systemd Watchdog
// =============================================================================

let watchdogInterval = null;

function startWatchdog() {
    if (!process.env.NOTIFY_SOCKET) {
        console.log('[Bridge] Not running under systemd watchdog, skipping sd_notify');
        return;
    }
    const pingInterval = 120_000;
    console.log(`[Bridge] Starting systemd watchdog pings every ${pingInterval / 1000}s (NOTIFY_SOCKET=${process.env.NOTIFY_SOCKET})`);

    sdNotify('WATCHDOG=1');
    watchdogInterval = setInterval(() => sdNotify('WATCHDOG=1'), pingInterval);
}

function sdNotify(state) {
    try {
        execSync(`systemd-notify --pid=${process.pid} ${state}`, {
            timeout: 5000,
            stdio: 'ignore',
        });
    } catch {
        // systemd-notify unavailable or failed — non-fatal
    }
}

function stopWatchdog() {
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
}

// =============================================================================
// HTTP Server
// =============================================================================

const app = express();

// CORS — allow external dashboards to fetch status
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

// SSE event stream — registered BEFORE auth guard (read-only)
const sseClients = new Set();

app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    const state = stateManager.getState();
    const plans = [];
    const pendingDir = path.join(REPO_PATH, config.plansDir || 'plans', 'pending');
    try {
        for (const f of fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'))) {
            const id = f.replace(/\.md$/, '');
            if (!state.processedPlans?.[id]) plans.push({ planId: id, status: 'pending' });
        }
    } catch {}
    for (const [id, info] of Object.entries(state.processedPlans || {})) {
        plans.push({ planId: id, status: info.status });
    }

    const initPayload = {
        recentLogs: bus.getRecentLogs(50),
        plans,
        activeAgents: getActiveAgents(),
    };
    res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// Agent management — before auth guard (dashboard-accessible)
app.get('/api/agents', (req, res) => {
    res.json({ agents: getActiveAgents() });
});

app.post('/api/agents/cancel', express.json(), (req, res) => {
    const { key, planId, agent } = req.body || {};
    const targetKey = key || (planId && agent ? `${planId}/${agent}` : null);
    if (!targetKey) {
        return res.status(400).json({
            error: 'Provide "key" (planId/agent) or both "planId" and "agent"',
        });
    }
    const result = cancelAgent(targetKey);
    if (result.cancelled) {
        bus.agent('cancelled', { planId: planId || targetKey.split('/')[0], agent: agent || targetKey.split('/')[1] });
        res.json({ status: 'cancelled', key: targetKey });
    } else {
        res.status(404).json({ error: result.error });
    }
});

app.post('/api/agents/cancel-all', (req, res) => {
    const agents = getActiveAgents();
    if (agents.length === 0) {
        return res.json({ status: 'no_active_agents', cancelled: 0 });
    }
    const results = agents.map(a => {
        const r = cancelAgent(a.key);
        if (r.cancelled) bus.agent('cancelled', { planId: a.planId, agent: a.agent });
        return { key: a.key, ...r };
    });
    res.json({ status: 'cancelled', cancelled: results.filter(r => r.cancelled).length, results });
});

// Auth guard — protects remaining /api/* routes
app.use('/api', authMiddleware);

app.get('/health', (req, res) => {
    res.json({
        service: 'claude-bridge',
        status: 'running',
        uptime: process.uptime(),
        processedPlans: stateManager.getProcessedCount(),
        activeAgents: watcher.getActiveCount(),
        authOk: app._authOk !== false,
        timestamp: new Date().toISOString(),
    });
});

app.get('/api/bridge/status', (req, res) => {
    res.json({
        service: 'claude-bridge',
        config: {
            repoPath: REPO_PATH,
            pollIntervalMs: POLL_INTERVAL,
            maxConcurrentAgents: config.maxConcurrentAgents,
        },
        state: stateManager.getState(),
        activeAgents: watcher.getActiveCount(),
        timestamp: new Date().toISOString(),
    });
});

// =============================================================================
// Plan Submission & Listing
// =============================================================================

const PLANS_DIR = path.resolve(REPO_PATH, config.plansDir || 'plans');

/**
 * Normalize team input into the canonical array-of-objects format.
 */
function normalizeTeam(team) {
    if (!Array.isArray(team)) {
        return [{ agent: String(team), scope: ['**'] }];
    }
    return team.map(member => {
        if (typeof member === 'string') {
            return { agent: member, scope: ['**'] };
        }
        if (member && typeof member === 'object' && member.agent) {
            return {
                agent: member.agent,
                scope: member.scope || ['**'],
                ...(member.blocked_files ? { blocked_files: member.blocked_files } : {}),
                ...(member.depends_on ? { depends_on: member.depends_on } : {}),
            };
        }
        return { agent: String(member), scope: ['**'] };
    });
}

app.post('/api/plans/submit', (req, res) => {
    const { title, priority, team, branch, body, max_turns_per_agent, tags } = req.body;

    if (!title || !priority || !team || !branch || !body) {
        return res.status(400).json({
            error: 'Missing required fields: title, priority, team, branch, body',
        });
    }

    const planId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const frontmatter = {
        id: planId,
        title,
        created: new Date().toISOString(),
        created_by: req.body.created_by || 'api',
        priority,
        branch,
        team: normalizeTeam(team),
    };
    if (max_turns_per_agent) frontmatter.max_turns_per_agent = max_turns_per_agent;
    if (tags) frontmatter.tags = tags;

    const { valid, errors } = validatePlan(frontmatter);
    if (!valid) {
        return res.status(400).json({ error: 'Plan validation failed', details: errors });
    }

    const knownAgents = config.agents || {};
    const unknownAgents = frontmatter.team
        .map(m => m.agent)
        .filter(a => !(a in knownAgents));
    if (unknownAgents.length > 0) {
        console.warn(`[Bridge] Plan ${planId}: unknown agent role(s): ${unknownAgents.join(', ')} (no prompt template may exist)`);
    }

    const yamlLines = [
        '---',
        `id: "${frontmatter.id}"`,
        `title: "${frontmatter.title}"`,
        `created: "${frontmatter.created}"`,
        `created_by: "${frontmatter.created_by}"`,
        `priority: "${frontmatter.priority}"`,
        `branch: "${frontmatter.branch}"`,
        `team:`,
    ];
    for (const member of frontmatter.team) {
        yamlLines.push(`  - agent: "${member.agent}"`);
        yamlLines.push(`    scope: [${(member.scope || []).map(s => `"${s}"`).join(', ')}]`);
        if (member.blocked_files?.length) {
            yamlLines.push(`    blocked_files: [${member.blocked_files.map(s => `"${s}"`).join(', ')}]`);
        }
        if (member.depends_on?.length) {
            yamlLines.push(`    depends_on: [${member.depends_on.map(s => `"${s}"`).join(', ')}]`);
        }
    }
    if (frontmatter.max_turns_per_agent) {
        yamlLines.push(`max_turns_per_agent: ${frontmatter.max_turns_per_agent}`);
    }
    if (frontmatter.tags) {
        yamlLines.push(`tags: [${frontmatter.tags.map(t => `"${t}"`).join(', ')}]`);
    }
    yamlLines.push('---');
    const fileContent = yamlLines.join('\n') + '\n\n' + body + '\n';

    const pendingDir = path.join(PLANS_DIR, 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const filePath = path.join(pendingDir, `${planId}.md`);

    if (fs.existsSync(filePath)) {
        return res.status(409).json({ error: `Plan '${planId}' already exists in pending` });
    }

    fs.writeFileSync(filePath, fileContent);
    console.log(`[Bridge] Plan submitted via API: ${planId}`);
    bus.plan('queued', { planId, title, agents: frontmatter.team.map(m => m.agent), status: 'pending' });

    res.status(201).json({
        planId,
        status: 'queued',
        path: `plans/pending/${planId}.md`,
    });
});

app.get('/api/plans', (req, res) => {
    const statusFilter = req.query.status;
    const state = stateManager.getState();
    const processed = state.processedPlans || {};

    const plans = [];
    const pendingDir = path.join(PLANS_DIR, 'pending');
    try {
        const pendingFiles = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
        for (const file of pendingFiles) {
            const id = file.replace(/\.md$/, '');
            if (!processed[id]) {
                plans.push({ id, status: 'pending', file });
            }
        }
    } catch {
        // pending dir may not exist yet
    }

    for (const [id, info] of Object.entries(processed)) {
        plans.push({ id, status: info.status, processedAt: info.processedAt, result: info.result });
    }

    const filtered = statusFilter
        ? plans.filter(p => p.status === statusFilter)
        : plans;

    res.json({ plans: filtered, total: filtered.length });
});

// =============================================================================
// SSE Dashboard
// =============================================================================

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

function broadcastSSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch {}
    }
}

// Wire event bus -> SSE broadcast
bus.on('log', (entry) => broadcastSSE('log', entry));
bus.on('plan', (data) => broadcastSSE('plan', data));
bus.on('agent', (data) => broadcastSSE('agent', data));
bus.on('status', (data) => broadcastSSE('status', data));

// Intercept console to pipe through event bus
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

function extractTag(args) {
    const first = String(args[0] || '');
    const match = first.match(/^\[(\w+)\]\s*/);
    if (match) {
        const tag = match[1];
        const rest = first.slice(match[0].length);
        return { tag, message: [rest, ...args.slice(1)].join(' ') };
    }
    return { tag: 'System', message: args.join(' ') };
}

console.log = (...args) => {
    origLog(...args);
    const { tag, message } = extractTag(args);
    bus.log('info', tag, message);
};
console.warn = (...args) => {
    origWarn(...args);
    const { tag, message } = extractTag(args);
    bus.log('warn', tag, message);
};
console.error = (...args) => {
    origError(...args);
    const { tag, message } = extractTag(args);
    bus.log('error', tag, message);
};

// Periodic status broadcast (every 15s) + live agent heartbeats
setInterval(() => {
    bus.status({
        uptime: process.uptime(),
        activeAgents: watcher.getActiveCount(),
        processedPlans: stateManager.getProcessedCount(),
        pendingPlans: (() => {
            try {
                return fs.readdirSync(path.join(PLANS_DIR, 'pending')).filter(f => f.endsWith('.md')).length;
            } catch { return 0; }
        })(),
        authOk: app._authOk !== false,
        sseClients: sseClients.size,
    });

    for (const a of getActiveAgents()) {
        bus.agent('heartbeat', {
            planId: a.planId,
            agent: a.agent,
            turns: a.turns,
            uptimeSeconds: a.uptimeSeconds,
            status: 'running',
        });
    }
}, 15000);

// =============================================================================
// Start
// =============================================================================

app.listen(PORT, async () => {
    console.log(`[Bridge] Daemon listening on port ${PORT}`);
    console.log(`[Bridge] Repo: ${REPO_PATH}`);
    console.log(`[Bridge] Poll interval: ${POLL_INTERVAL / 1000}s`);

    startWatchdog();

    const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
    const auth = await preflightAuth(claudePath);
    if (!auth.ok) {
        console.error(`[Bridge] STARTUP AUTH FAILED: ${auth.error}`);
        console.error('[Bridge] Fix: ensure OAuth is valid (run "claude" interactively) or set CLAUDE_API_KEY in .env');
        console.error('[Bridge] Daemon will start but agent spawns will fail until auth is fixed.');
        app._authOk = false;
    } else {
        console.log('[Bridge] Startup auth check passed');
        app._authOk = true;
    }

    watcher.start();
});

process.on('SIGINT', () => {
    console.log('\n[Bridge] Shutting down...');
    stopWatchdog();
    watcher.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Bridge] SIGTERM received, shutting down...');
    stopWatchdog();
    watcher.stop();
    process.exit(0);
});
