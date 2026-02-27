/**
 * app/api/embeddings/route.ts
 */

import { guardOrigin } from "@/lib/security";
import { checkRateLimit, getIP } from "@/lib/rateLimit";

export const runtime = "edge";

const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBED_MODEL = "openai/text-embedding-3-small";
const MAX_SINGLE_LENGTH = 4000;

// Лимит: 60 запросов на 10 минут (эмбеддинги обычно чаще)
const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 10 * 60 * 1000 };

export async function POST(request: Request): Promise<Response> {
    const blocked = guardOrigin(request);
    if (blocked) return blocked;

    const ip = getIP(request);
    if (!checkRateLimit(ip, RATE_LIMIT_CONFIG)) {
        return Response.json({ error: "Too many requests" }, { status: 429 });
    }

    let body: any;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const input = body.input;
    if (!input || (typeof input === "string" && input.length > MAX_SINGLE_LENGTH)) {
        return Response.json({ error: "Input missing or too long" }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return Response.json({ error: "Server config error" }, { status: 500 });
    }

    try {
        const upstream = await fetch(OPENROUTER_EMBED_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input,
            }),
        });

        if (!upstream.ok) return Response.json({ error: "Upstream Error" }, { status: upstream.status });

        const data = await upstream.json();
        return Response.json(data);
    } catch (err) {
        return Response.json({ error: "Network Error" }, { status: 502 });
    }
}
