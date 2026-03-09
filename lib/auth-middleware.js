'use strict';

/**
 * Bearer token auth middleware for Bridge Daemon API routes.
 * Validates against BRIDGE_API_TOKEN env var. Bypasses /health for monitoring.
 */
module.exports = function authMiddleware(req, res, next) {
    // Allow health check without auth (monitoring probes)
    if (req.path === '/health') return next();

    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!process.env.BRIDGE_API_TOKEN) {
        console.warn('[Auth] BRIDGE_API_TOKEN not set — all API requests will be rejected');
        return res.status(500).json({ error: 'Server misconfigured: no API token set' });
    }

    if (!token || token !== process.env.BRIDGE_API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
};
