'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parsePlan, validatePlan } = require('./plan-parser');

/**
 * PlanWatcher — Polls for new plan files via git and local filesystem.
 *
 * Poll cycle:
 * 1. git fetch origin bridge/plans (if remote branch exists)
 * 2. List local plans/pending/ directory
 * 3. For each unprocessed plan: parse, validate, hand off to callback
 */
class PlanWatcher {
    constructor({ repoPath, pollInterval, stateManager, onNewPlan, maxConcurrentAgents }) {
        this.repoPath = repoPath;
        this.pollInterval = pollInterval || 30000;
        this.stateManager = stateManager;
        this.onNewPlan = onNewPlan;
        this.maxConcurrentAgents = maxConcurrentAgents || 5;
        this._timer = null;
        this._activeCount = 0;
    }

    start() {
        console.log(`[PlanWatcher] Starting (poll every ${this.pollInterval / 1000}s)`);
        this._timer = setInterval(() => this.poll(), this.pollInterval);
        // Run first poll immediately
        this.poll();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        console.log('[PlanWatcher] Stopped');
    }

    getActiveCount() {
        return this._activeCount;
    }

    getAvailableSlots() {
        return Math.max(0, this.maxConcurrentAgents - this._activeCount);
    }

    /**
     * Reserve agent slots before spawning. Returns true if slots were reserved.
     */
    reserveSlots(count) {
        if (this._activeCount + count > this.maxConcurrentAgents) {
            return false;
        }
        this._activeCount += count;
        return true;
    }

    releaseSlots(count) {
        this._activeCount = Math.max(0, this._activeCount - count);
    }

    async poll() {
        if (this._polling) return;
        this._polling = true;

        try {
            this._gitFetch();

            const pendingDir = path.join(this.repoPath, 'plans', 'pending');
            if (!fs.existsSync(pendingDir)) return;

            const files = fs.readdirSync(pendingDir)
                .filter(f => f.endsWith('.md') && f !== '.gitkeep');

            for (const file of files) {
                const filePath = path.join(pendingDir, file);
                const planId = path.basename(file, '.md');

                if (this.stateManager.isProcessed(planId)) continue;

                console.log(`[PlanWatcher] New plan detected: ${planId}`);

                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const { frontmatter, body, parseError } = parsePlan(content);

                    if (parseError) {
                        console.error(`[PlanWatcher] YAML parse error in ${planId}: ${parseError}`);
                        this.stateManager.markProcessed(planId, 'failed', {
                            reason: 'yaml_parse_error',
                            error: parseError,
                        });
                        this._movePlan(filePath, 'failed');
                        continue;
                    }

                    const { valid, errors } = validatePlan(frontmatter);

                    if (!valid) {
                        console.error(`[PlanWatcher] Invalid plan ${planId}:`, errors);
                        this.stateManager.markProcessed(planId, 'failed', {
                            reason: 'validation_error',
                            errors,
                        });
                        this._movePlan(filePath, 'failed');
                        continue;
                    }

                    const teamSize = (frontmatter.team || []).length || 1;
                    if (!this.reserveSlots(teamSize)) {
                        console.log(`[PlanWatcher] At capacity (${this._activeCount}/${this.maxConcurrentAgents}), deferring ${planId} (needs ${teamSize} slots)`);
                        break;
                    }

                    this._movePlan(filePath, 'in-progress');

                    const inProgressPath = path.join(pendingDir, '..', 'in-progress', file);
                    this.onNewPlan({ planId, frontmatter, body, filePath })
                        .then(() => {
                            this._movePlan(inProgressPath, 'done');
                        })
                        .catch((err) => {
                            console.error(`[PlanWatcher] Agent failed for ${planId}:`, err.message);
                            this.stateManager.markProcessed(planId, 'failed', {
                                reason: 'agent_error',
                                error: err.message,
                            });
                            this._movePlan(inProgressPath, 'failed');
                        })
                        .finally(() => {
                            this.releaseSlots(teamSize);
                        });
                } catch (err) {
                    console.error(`[PlanWatcher] Error reading ${planId}:`, err.message);
                }
            }
        } catch (err) {
            console.error(`[PlanWatcher] Poll error:`, err.message);
        } finally {
            this._polling = false;
        }
    }

    _gitFetch() {
        try {
            execSync('git fetch origin bridge/plans 2>/dev/null', {
                cwd: this.repoPath,
                timeout: 15000,
                stdio: 'pipe',
            });
        } catch {
            // Remote branch may not exist yet — that's fine
        }
    }

    _movePlan(fromPath, toDir) {
        try {
            const destDir = path.join(this.repoPath, 'plans', toDir);
            fs.mkdirSync(destDir, { recursive: true });
            const destPath = path.join(destDir, path.basename(fromPath));
            if (fs.existsSync(fromPath)) {
                fs.renameSync(fromPath, destPath);
                console.log(`[PlanWatcher] Moved ${path.basename(fromPath)} -> ${toDir}/`);
            }
        } catch (err) {
            console.error(`[PlanWatcher] Move failed: ${err.message}`);
        }
    }
}

module.exports = PlanWatcher;
