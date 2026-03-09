'use strict';

const fs = require('fs');
const path = require('path');

/**
 * StateManager — Tracks which plans have been processed.
 * Persists to state.json so the daemon survives restarts.
 */
class StateManager {
    constructor(statePath) {
        this.statePath = statePath;
        this.state = { processedPlans: {}, startedAt: new Date().toISOString() };
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.statePath)) {
                const raw = fs.readFileSync(this.statePath, 'utf-8');
                this.state = JSON.parse(raw);
            }
        } catch (err) {
            console.error(`[StateManager] Failed to load state: ${err.message}`);
        }
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        } catch (err) {
            console.error(`[StateManager] Failed to save state: ${err.message}`);
        }
    }

    isProcessed(planId) {
        return planId in (this.state.processedPlans || {});
    }

    markProcessed(planId, status, result) {
        this.state.processedPlans[planId] = {
            status,
            processedAt: new Date().toISOString(),
            result: result || null,
        };
        this._save();
    }

    /**
     * Mark a multi-agent plan as processed with per-agent results.
     * @param {string} planId
     * @param {string} overallStatus - 'completed' | 'partial' | 'failed'
     * @param {Object} agentResults - { [agentRole]: { status, sessionId, prUrl, error } }
     * @param {Object} [summary] - { resultPath }
     */
    markTeamProcessed(planId, overallStatus, agentResults, summary) {
        this.state.processedPlans[planId] = {
            status: overallStatus,
            processedAt: new Date().toISOString(),
            agents: agentResults,
            result: summary || null,
        };
        this._save();
    }

    getProcessedCount() {
        return Object.keys(this.state.processedPlans || {}).length;
    }

    getState() {
        return { ...this.state };
    }
}

module.exports = StateManager;
