/**
 * app/api/chat/route.ts
 *
 * Серверный роут с поддержкой Streaming (SSE), Rate Limiting и валидацией Origin.
 */

import { guardOrigin } from "@/lib/security";
import { checkRateLimit, getIP } from "@/lib/rateLimit";

export const runtime = "edge";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini";
const TEMPERATURE = 0.2;
const MAX_TOKENS = 800; // Ограничение на длину ответа
const MAX_MESSAGE_LENGTH = 10000;
const MAX_HISTORY_MESSAGES = 15;

// Лимит: 30 запросов на 10 минут
const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 10 * 60 * 1000 };

const SYSTEM_PROMPT = `You are a support bot for Sova (https://docs.sova.io).

RULES:
1. Answer ONLY based on the provided CONTEXT.
2. If the answer is not in the CONTEXT - say: "This information was not found in Sova documentation."
3. DO NOT write a list of links or sources at the end of the response.
4. Respond in English by default.
5. FORMATTING: Use valid Markdown. 
   - For numbered lists, ALWAYS use "1. ", "2. " (digit + dot + space).
   - IMPORTANT: ALWAYS put a BLANK LINE before starting a list and between list items.
6. BOLDING: Use **Bold** for key terms and component names.
7. Be concise and professional.`;

export async function POST(request: Request): Promise<Response> {
    // 1. Security: Origin check
    const blocked = guardOrigin(request);
    if (blocked) return blocked;

    // 2. Security: Rate Limit
    const ip = getIP(request);
    if (!checkRateLimit(ip, RATE_LIMIT_CONFIG)) {
        return Response.json({ error: "Too many requests. Please try again in 10 minutes." }, { status: 429 });
    }

    // 3. Parse & Validate body
    let body: any;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const messages = body.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
        return Response.json({ error: "Messages array is required" }, { status: 400 });
    }

    // Применяем лимит на историю
    const slicedMessages = messages.slice(-MAX_HISTORY_MESSAGES);

    // Валидация каждого сообщения
    for (const m of slicedMessages) {
        if (typeof m.content !== "string" || m.content.length > MAX_MESSAGE_LENGTH) {
            return Response.json({ error: "Message too long or invalid" }, { status: 400 });
        }
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return Response.json({ error: "Server config error: API Key missing" }, { status: 500 });
    }

    // 4. Call OpenRouter with Streaming
    try {
        const upstream = await fetch(OPENROUTER_CHAT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": request.headers.get("origin") || "http://localhost:3000",
                "X-Title": "AI Sova Chat",
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: TEMPERATURE,
                max_tokens: MAX_TOKENS,
                stream: true, // Включаем стриминг
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    ...slicedMessages,
                ],
            }),
        });

        if (!upstream.ok) {
            const err = await upstream.text();
            return Response.json({ error: "OpenRouter Error", detail: err }, { status: upstream.status });
        }

        // Прокидываем поток напрямую клиенту
        return new Response(upstream.body, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    } catch (err) {
        console.error("Chat Stream Error:", err);
        return Response.json({ error: "Network Error" }, { status: 502 });
    }
}
