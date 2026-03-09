'use strict';

const { EventEmitter } = require('events');

/**
 * Singleton event bus for Bridge Daemon.
 * Broadcasts plan/agent lifecycle events to SSE clients.
 *
 * Events:
 *   log       — { level, tag, message, timestamp }
 *   plan      — { action, planId, title, agents, status, timestamp }
 *   agent     — { action, planId, agent, turns, idle, status, prUrl, timestamp }
 *   status    — { uptime, activeAgents, processedPlans, timestamp }
 */
class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50); // SSE clients
        this._logs = [];       // ring buffer (last 200 entries)
        this._maxLogs = 200;
    }

    /** Emit a structured log event and buffer it. */
    log(level, tag, message) {
        const entry = { level, tag, message, timestamp: new Date().toISOString() };
        this._logs.push(entry);
        if (this._logs.length > this._maxLogs) this._logs.shift();
        this.emit('log', entry);
    }

    /** Get buffered logs (for initial SSE connection). */
    getRecentLogs(count = 50) {
        return this._logs.slice(-count);
    }

    /** Emit plan lifecycle event. */
    plan(action, data) {
        this.emit('plan', { action, ...data, timestamp: new Date().toISOString() });
    }

    /** Emit agent lifecycle event. */
    agent(action, data) {
        this.emit('agent', { action, ...data, timestamp: new Date().toISOString() });
    }

    /** Emit daemon status snapshot. */
    status(data) {
        this.emit('status', { ...data, timestamp: new Date().toISOString() });
    }
}

module.exports = new EventBus();
