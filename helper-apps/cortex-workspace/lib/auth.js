import crypto from 'node:crypto';

const WORKSPACE_SECRET = process.env.WORKSPACE_SECRET;

/**
 * Express middleware for shared secret authentication.
 * Validates x-workspace-secret header using timing-safe comparison.
 */
export function requireAuth(req, res, next) {
    if (!WORKSPACE_SECRET) {
        return res.status(500).json({ error: 'Server misconfigured: no secret set' });
    }

    const provided = req.headers['x-workspace-secret'];
    if (!provided || typeof provided !== 'string') {
        return res.status(401).json({ error: 'Missing x-workspace-secret header' });
    }

    const expected = Buffer.from(WORKSPACE_SECRET, 'utf8');
    const actual = Buffer.from(provided, 'utf8');

    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return res.status(401).json({ error: 'Invalid secret' });
    }

    next();
}
