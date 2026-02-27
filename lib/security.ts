/**
 * lib/security.ts
 *
 * Origin / Referer validation driven by the APP_ORIGINS env variable.
 *
 * APP_ORIGINS (optional, comma-separated list):
 *   "http://localhost:3000,https://myapp.vercel.app,https://mydomain.com"
 *
 * Default (when APP_ORIGINS is not set):
 *   - http://localhost:* (any port)
 *   - https://*.vercel.app
 */

function parseAllowedOrigins(): string[] | null {
    const raw = process.env.APP_ORIGINS;
    if (!raw || !raw.trim()) return null;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function matchesDefault(origin: string): boolean {
    try {
        const url = new URL(origin);
        if (url.hostname === "localhost") return true;
        if (url.hostname.endsWith(".vercel.app")) return true;
        return false;
    } catch {
        return false;
    }
}

function matchesAllowedList(origin: string, list: string[]): boolean {
    return list.some((allowed) => origin.startsWith(allowed));
}

/**
 * Returns true if the request is allowed to proceed.
 * Call from Edge API routes.
 */
export function isOriginAllowed(request: Request): boolean {
    const origin = request.headers.get("origin") ?? "";
    const referer = request.headers.get("referer") ?? "";

    // Pick the best candidate
    const candidate = origin || extractOriginFromReferer(referer);

    // No origin at all
    if (!candidate) {
        // Allow only in dev (localhost-like scenarios with no Origin header)
        // In production (Vercel), every browser request sends Origin.
        return process.env.NODE_ENV !== "production";
    }

    const allowedList = parseAllowedOrigins();

    if (allowedList) {
        return matchesAllowedList(candidate, allowedList);
    }

    // Default: localhost or *.vercel.app
    return matchesDefault(candidate);
}

function extractOriginFromReferer(referer: string): string {
    if (!referer) return "";
    try {
        const url = new URL(referer);
        return `${url.protocol}//${url.host}`;
    } catch {
        return "";
    }
}

/**
 * Returns a 403 Response if origin check fails, otherwise null.
 * Convenience wrapper for route handlers.
 */
export function guardOrigin(request: Request): Response | null {
    if (!isOriginAllowed(request)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}
