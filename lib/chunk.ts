/**
 * lib/chunk.ts
 *
 * Text chunking utilities for the KB build step.
 * No external dependencies required.
 */

export interface RawChunk {
    id: string;
    url: string;
    text: string;
}

/**
 * Split `text` into overlapping windows.
 *
 * @param text        - cleaned text from one page
 * @param url         - source URL, used to build chunk id
 * @param targetSize  - target chunk size in characters (default 1000)
 * @param overlap     - overlap in characters between adjacent chunks (default 175)
 * @returns           - array of RawChunk
 */
export function chunkText(
    text: string,
    url: string,
    targetSize = 1000,
    overlap = 175
): RawChunk[] {
    // Normalise whitespace: collapse runs of whitespace into single spaces/newlines
    const normalised = text
        .replace(/[ \t]+/g, " ")      // collapse horizontal whitespace
        .replace(/\n{3,}/g, "\n\n")   // max 2 consecutive newlines
        .trim();

    if (normalised.length === 0) return [];

    // Split on paragraph boundaries for more natural cuts
    const paragraphs = splitIntoParagraphs(normalised);
    const chunks: RawChunk[] = [];
    let buffer = "";
    let chunkIndex = 0;

    function flush() {
        const trimmed = buffer.trim();
        if (trimmed.length < 50) return; // skip tiny fragments
        chunks.push({
            id: `${url}::chunk${chunkIndex++}`,
            url,
            text: trimmed,
        });
    }

    for (const para of paragraphs) {
        // If adding this paragraph exceeds targetSize and buffer is non-empty → flush
        if (buffer.length + para.length > targetSize && buffer.length > 0) {
            flush();
            // Overlap: keep the last `overlap` chars of the previous chunk
            const tail = buffer.slice(-overlap);
            buffer = tail + "\n\n" + para;
        } else {
            buffer = buffer ? buffer + "\n\n" + para : para;
        }

        // If a single paragraph is larger than targetSize, force-split it
        while (buffer.length > targetSize * 1.2) {
            const slice = buffer.slice(0, targetSize);
            const cutAt = findBreakPoint(slice);
            chunks.push({
                id: `${url}::chunk${chunkIndex++}`,
                url,
                text: buffer.slice(0, cutAt).trim(),
            });
            buffer = buffer.slice(cutAt - overlap);
        }
    }

    if (buffer.trim()) flush();

    return chunks;
}

/** Split text into paragraphs (double-newline separated). */
function splitIntoParagraphs(text: string): string[] {
    return text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

/**
 * Find a good break point (sentence end or word boundary) near `pos`.
 * Prefer breaking at the last period/exclamation/question within the window.
 */
function findBreakPoint(text: string): number {
    // Try to break at end of sentence
    const sentenceEnd = text.search(/[.!?]\s+\S*$/);
    if (sentenceEnd > text.length * 0.6) return sentenceEnd + 1;

    // Fall back to last word boundary
    const lastSpace = text.lastIndexOf(" ");
    if (lastSpace > text.length * 0.5) return lastSpace;

    return text.length;
}

/**
 * Clean raw HTML string to plain text.
 * Removes script/style/nav/header/footer and collapses whitespace.
 *
 * NOTE: This is a simple regex-based cleaner suitable for a build script.
 * It does NOT execute JS or handle escaped HTML entities perfectly.
 */
export function cleanHtml(html: string): string {
    let text = html;

    // Remove complete block-level unwanted elements (with content)
    text = text.replace(
        /<(script|style|nav|header|footer|aside|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi,
        " "
    );

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode common HTML entities
    text = decodeEntities(text);

    // Normalise whitespace
    text = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return text;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        );
}

/**
 * Extract all internal links from an HTML page.
 * Only keeps links under `baseDomain`.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
    const base = new URL(baseUrl);
    const seen = new Set<string>();
    const links: string[] = [];

    // Match href="..." and href='...'
    const hrefRe = /href=["']([^"'#?]+)["']/gi;
    let match: RegExpExecArray | null;

    while ((match = hrefRe.exec(html)) !== null) {
        const raw = match[1].trim();
        if (!raw) continue;

        try {
            const resolved = new URL(raw, baseUrl);
            // Only same hostname
            if (resolved.hostname !== base.hostname) continue;
            // Normalise: remove trailing slash, hash, query
            resolved.hash = "";
            resolved.search = "";
            const href = resolved.href.replace(/\/$/, "");
            if (!seen.has(href)) {
                seen.add(href);
                links.push(href);
            }
        } catch {
            // skip malformed URLs
        }
    }

    return links;
}
