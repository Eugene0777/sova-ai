/**
 * scripts/build_kb.ts
 *
 * Knowledge-base builder for AI Sova Chat RAG pipeline.
 *
 * Steps:
 *  1. Crawl docs.sova.io (BFS, max 50 pages)
 *  2. Clean HTML → plain text
 *  3. Split into 800-1200 char chunks with ~175 char overlap
 *  4. Save public/kb/chunks.json
 *  5. Get embeddings from OpenRouter (openai/text-embedding-3-small)
 *  6. Save public/kb/chunks_with_vectors.json
 *
 * Usage:
 *   npm run kb:build
 *
 * Requires:
 *   OPENROUTER_API_KEY in .env.local (loaded automatically via tsx --env-file)
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { cleanHtml, chunkText, extractLinks, RawChunk } from "../lib/chunk";

// ── Config ────────────────────────────────────────────────────────────────────

const SEED_URLS = [
    "https://docs.sova.io/",
    "https://docs.sova.io/using-sova/getting-started",
    "https://docs.sova.io/using-sova/faq",
    "https://docs.sova.io/technical-reference/fees",
    "https://docs.sova.io/technical-reference/security",
    "https://docs.sova.io/products/roadmap",
    "https://docs.sova.io/vault-technical-resources/protocol-overview",
];

const ALLOWED_HOSTNAME = "docs.sova.io";
const MAX_PAGES = 50;
const EMBED_BATCH_SIZE = 64;
const EMBED_MODEL = "openai/text-embedding-3-small";
const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";

const OUT_DIR = path.join(process.cwd(), "public", "kb");
const CHUNKS_PATH = path.join(OUT_DIR, "chunks.json");
const VECTORS_PATH = path.join(OUT_DIR, "chunks_with_vectors.json");

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchUrl(
    url: string,
    retries = 3,
    delayMs = 1000
): Promise<string | null> {
    return new Promise((resolve) => {
        const attempt = (n: number) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === "https:" ? https : http;

            const options = {
                hostname: parsed.hostname,
                path: (parsed.pathname || "/") + parsed.search,
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                },
                timeout: 15000,
            };

            const req = lib.request(options, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const loc = res.headers.location;
                    if (loc) {
                        const redirected = new URL(loc, url).href;
                        resolve(fetchUrl(redirected, retries, delayMs));
                    } else {
                        resolve(null);
                    }
                    return;
                }

                if (res.statusCode === 429 || (res.statusCode && res.statusCode >= 500)) {
                    if (n > 0) {
                        console.warn(
                            `  [${res.statusCode}] ${url} — retrying in ${delayMs}ms (${n} left)`
                        );
                        setTimeout(() => attempt(n - 1), delayMs);
                        return;
                    }
                    console.error(`  [${res.statusCode}] ${url} — giving up`);
                    resolve(null);
                    return;
                }

                if (res.statusCode !== 200) {
                    console.warn(`  [${res.statusCode}] ${url} — skipping`);
                    resolve(null);
                    return;
                }

                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
                res.on("error", (e) => {
                    console.error(`  Stream error ${url}: ${e.message}`);
                    resolve(null);
                });
            });

            req.on("timeout", () => {
                req.destroy();
                if (n > 0) {
                    console.warn(`  Timeout ${url} — retrying (${n} left)`);
                    setTimeout(() => attempt(n - 1), delayMs);
                } else {
                    console.error(`  Timeout ${url} — giving up`);
                    resolve(null);
                }
            });
            req.on("error", (e) => {
                if (n > 0) {
                    console.warn(`  Error ${url}: ${e.message} — retrying (${n} left)`);
                    setTimeout(() => attempt(n - 1), delayMs * 2);
                } else {
                    console.error(`  Error ${url}: ${e.message} — giving up`);
                    resolve(null);
                }
            });
            req.end();
        };
        attempt(retries);
    });
}

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Crawler ───────────────────────────────────────────────────────────────────

async function crawl(): Promise<RawChunk[]> {
    const visited = new Set<string>();
    const queue: string[] = [...SEED_URLS];
    const allChunks: RawChunk[] = [];
    let pageCount = 0;

    while (queue.length > 0 && pageCount < MAX_PAGES) {
        const url = queue.shift()!;
        const normalised = url.replace(/\/$/, "");
        if (visited.has(normalised)) continue;
        visited.add(normalised);

        // Only crawl docs.sova.io
        try {
            const hostname = new URL(url).hostname;
            if (hostname !== ALLOWED_HOSTNAME && hostname !== "www." + ALLOWED_HOSTNAME) continue;
        } catch {
            continue;
        }

        process.stdout.write(
            `[${pageCount + 1}/${MAX_PAGES}] Fetching: ${url} ... `
        );
        const html = await fetchUrl(url);

        if (!html) {
            console.log("SKIP");
            continue;
        }

        console.log(`OK (${html.length} bytes)`);
        pageCount++;

        // Extract links for BFS
        const links = extractLinks(html, url);
        for (const link of links) {
            const norm = link.replace(/\/$/, "");
            if (!visited.has(norm) && !queue.includes(link)) {
                queue.push(link);
            }
        }

        // Clean and chunk
        const text = cleanHtml(html);
        const chunks = chunkText(text, normalised, 1000, 175);
        console.log(`   → ${chunks.length} chunks`);
        allChunks.push(...chunks);

        // Polite crawl delay
        await sleep(300);
    }

    console.log(
        `\nCrawled ${pageCount} pages → ${allChunks.length} total chunks`
    );
    return allChunks;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

function postJson(
    url: string,
    body: object,
    apiKey: string,
    retries = 3,
    delayMs = 2000
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const parsed = new URL(url);

        const attempt = (n: number) => {
            const options = {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Length": Buffer.byteLength(payload),
                },
                timeout: 60000,
            };

            const req = https.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf-8");
                    if (res.statusCode === 429 || (res.statusCode && res.statusCode >= 500)) {
                        if (n > 0) {
                            const wait = delayMs * (4 - n);
                            console.warn(
                                `  [${res.statusCode}] embed batch — retrying in ${wait}ms (${n} left)`
                            );
                            setTimeout(() => attempt(n - 1), wait);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                        }
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`Invalid JSON: ${text.slice(0, 200)}`));
                    }
                });
                res.on("error", reject);
            });

            req.on("timeout", () => {
                req.destroy();
                if (n > 0) {
                    setTimeout(() => attempt(n - 1), delayMs * 2);
                } else {
                    reject(new Error("Timeout on embedding request"));
                }
            });
            req.on("error", (e) => {
                if (n > 0) {
                    setTimeout(() => attempt(n - 1), delayMs);
                } else {
                    reject(e);
                }
            });

            req.write(payload);
            req.end();
        };

        attempt(retries);
    });
}

interface EmbeddingResponseData {
    data: { embedding: number[]; index: number }[];
}

async function embedBatch(
    texts: string[],
    apiKey: string
): Promise<number[][]> {
    const response = (await postJson(
        OPENROUTER_EMBED_URL,
        { model: EMBED_MODEL, input: texts },
        apiKey
    )) as EmbeddingResponseData;

    // Sort by index to guarantee ordering matches input
    const sorted = response.data.slice().sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
}

async function addEmbeddings(
    chunks: RawChunk[],
    apiKey: string
): Promise<Array<RawChunk & { embedding: number[] }>> {
    const result: Array<RawChunk & { embedding: number[] }> = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(chunks.length / EMBED_BATCH_SIZE);

        process.stdout.write(
            `  Embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks) ... `
        );

        try {
            const embeddings = await embedBatch(
                batch.map((c) => c.text),
                apiKey
            );
            for (let j = 0; j < batch.length; j++) {
                result.push({ ...batch[j], embedding: embeddings[j] });
            }
            console.log("OK");
        } catch (err) {
            console.error(`FAILED: ${err}`);
            // Still include chunks but with empty embedding so we don't lose data
            for (const chunk of batch) {
                result.push({ ...chunk, embedding: [] });
            }
        }

        // Small pause between batches to respect rate limits
        if (i + EMBED_BATCH_SIZE < chunks.length) {
            await sleep(500);
        }
    }

    return result;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
    console.log("=== AI Sova KB Builder ===\n");

    // Ensure output directory exists
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Step 1–4: Crawl and chunk
    console.log("── Step 1: Crawling docs.sova.io ──");
    const chunks = await crawl();

    fs.writeFileSync(CHUNKS_PATH, JSON.stringify(chunks, null, 2), "utf-8");
    console.log(`\nSaved ${chunks.length} chunks → ${CHUNKS_PATH}`);

    // Step 5–6: Embeddings
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
        console.error(
            "\n❌  OPENROUTER_API_KEY is not set. " +
            "Create .env.local with the key and run: npm run kb:build\n" +
            "    Chunks saved without embeddings (chunks.json only)."
        );
        process.exit(1);
    }

    console.log(`\n── Step 2: Generating embeddings (${EMBED_MODEL}) ──`);
    const chunksWithVectors = await addEmbeddings(chunks, apiKey);

    // Validate that we have no empty embeddings (log warning)
    const emptyCount = chunksWithVectors.filter((c) => c.embedding.length === 0).length;
    if (emptyCount > 0) {
        console.warn(
            `⚠️  ${emptyCount} chunks have empty embeddings (embedding failures above).`
        );
    }

    fs.writeFileSync(
        VECTORS_PATH,
        JSON.stringify(chunksWithVectors, null, 2),
        "utf-8"
    );
    console.log(`\nSaved ${chunksWithVectors.length} vectors → ${VECTORS_PATH}`);

    const sizeKb = (fs.statSync(VECTORS_PATH).size / 1024).toFixed(0);
    console.log(`File size: ${sizeKb} KB`);

    console.log("\n✅  KB build complete!\n");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
