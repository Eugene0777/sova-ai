export type Role = "user" | "assistant";

export interface Message {
    id: string;
    role: Role;
    content: string;
    /** Source URLs used for retrieval (only for assistant messages) */
    sources?: string[];
}

/** A KB chunk with pre-computed embedding */
export interface KbChunk {
    id: string;
    url: string;
    text: string;
    embedding: number[];
}
