/**
 * lib/rateLimit.ts
 *
 * Простой in-memory лимитер запросов.
 * Работает по принципу "лучшего старания" (best effort), так как на Vercel Edge
 * память может сбрасываться между запросами.
 */

interface RateLimitStore {
    [ip: string]: {
        count: number;
        resetTime: number;
    };
}

const store: RateLimitStore = {};

export interface RateLimitConfig {
    limit: number;      // макс количество запросов
    windowMs: number;   // окно времени в мс
}

/**
 * Проверяет, превышен ли лимит для данного IP.
 * Возвращает true, если запрос разрешен, и false, если лимит превышен.
 */
export function checkRateLimit(ip: string, config: RateLimitConfig): boolean {
    const now = Date.now();
    const record = store[ip];

    if (!record || now > record.resetTime) {
        store[ip] = {
            count: 1,
            resetTime: now + config.windowMs,
        };
        return true;
    }

    record.count++;
    return record.count <= config.limit;
}

/**
 * Извлекает IP из заголовков запроса.
 */
export function getIP(request: Request): string {
    return request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
}
