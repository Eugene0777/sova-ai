/**
 * lib/similarity.ts
 *
 * Cosine similarity for dense vectors (number[]).
 * Runs in the browser and on the server (no dependencies).
 */

/**
 * Compute the dot product of two vectors.
 */
function dot(a: number[], b: number[]): number {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += a[i] * b[i];
    return sum;
}

/**
 * Compute the L2 norm (magnitude) of a vector.
 */
function norm(a: number[]): number {
    return Math.sqrt(dot(a, a));
}

/**
 * Cosine similarity in [-1, 1].
 * Returns 0 for zero vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    const na = norm(a);
    const nb = norm(b);
    if (na === 0 || nb === 0) return 0;
    return dot(a, b) / (na * nb);
}

export interface ScoredChunk<T> {
    item: T;
    score: number;
}

/**
 * Find the topK most similar items to a query embedding.
 *
 * @param query  - embedding of the user question
 * @param items  - array of items with an `embedding` field
 * @param topK   - how many results to return
 * @returns      - array sorted by score descending
 */
export function topKNearest<T extends { embedding: number[] }>(
    query: number[],
    items: T[],
    topK: number
): ScoredChunk<T>[] {
    const scored = items.map((item) => ({
        item,
        score: cosineSimilarity(query, item.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}
