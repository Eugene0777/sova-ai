"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  FormEvent,
  KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { Message, KbChunk } from "@/types/chat";
import { topKNearest } from "@/lib/similarity";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_INPUT_LENGTH = 2000;
const MAX_CONTEXT_CHARS = 7000;
const TOP_K = 6;
const SIMILARITY_THRESHOLD = 0.28;
const NOT_FOUND_REPLY = "This information was not found in Sova documentation. Try clarifying your question.";

function uid() {
  return Math.random().toString(36).slice(2);
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbReady, setKbReady] = useState(false);
  const [kbError, setKbError] = useState(false);

  // Ref for AbortController
  const abortControllerRef = useRef<AbortController | null>(null);
  const kbRef = useRef<KbChunk[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Load KB ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Небольшая задержка, чтобы убедиться, что гидратация прошла успешно
    const timer = setTimeout(() => {
      fetch("/kb/chunks_with_vectors.json")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          kbRef.current = data;
          setKbReady(true);
          setKbError(false);
          setError(null);
        })
        .catch((err) => {
          console.error("Knowledge Base failed to load:", err);
          setError(`KB LOAD ERROR: ${err.message}. Check if /public/kb/ exists on Vercel.`);
          setKbReady(false);
          setKbError(true);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // ── Auto-scroll ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, loading]);

  // ── Utils ───────────────────────────────────────────────────────────────────
  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  const updateLastAssistantMessage = (content: string, sources?: string[]) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, content: last.content + content, sources: sources || last.sources },
        ];
      }
      return [
        ...prev,
        { id: uid(), role: "assistant", content, sources: sources || [] },
      ];
    });
  };

  // ── Action ──────────────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    setLoading(true);
    setInput("");

    // Setup AbortController
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userMsg: Message = { id: uid(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    try {
      // 1. Get Embedding
      const embedRes = await fetch("/api/embeddings", {
        method: "POST",
        body: JSON.stringify({ input: text }),
        signal: controller.signal,
      });
      if (!embedRes.ok) throw new Error(embedRes.status === 429 ? "Too many requests. Please wait." : "Connection error");
      const embedData = await embedRes.json();
      const queryVector = embedData.data[0].embedding;

      // 2. Retrieval
      const ranked = topKNearest(queryVector, kbRef.current, TOP_K);
      const topChunks = ranked.filter(r => r.score >= SIMILARITY_THRESHOLD).map(r => r.item);
      const sources = Array.from(new Set(topChunks.map(c => c.url)));

      if (topChunks.length === 0) {
        setMessages(prev => [...prev, { id: uid(), role: "assistant", content: NOT_FOUND_REPLY, sources: [] }]);
        setLoading(false);
        return;
      }

      // 3. Build Context
      let contextStr = "";
      for (const chunk of topChunks) {
        const entry = `[SOURCE] ${chunk.url}\n${chunk.text}\n---\n`;
        if (contextStr.length + entry.length > MAX_CONTEXT_CHARS) break;
        contextStr += entry;
      }

      // 4. Streaming Chat
      const chatHistory = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
      const lastIdx = chatHistory.length - 1;
      chatHistory[lastIdx].content = `QUESTION: ${text}\n\nCONTEXT:\n${contextStr}\n\nSOURCES_JSON: ${JSON.stringify(sources)}`;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatHistory }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("Server error");
      if (!response.body) throw new Error("No data stream");

      // Initial empty message for assistant
      setMessages(prev => [...prev, { id: uid(), role: "assistant", content: "", sources }]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.substring(6); // Remove "data: "
          if (dataStr === "[DONE]") break;

          try {
            const json = JSON.parse(dataStr);
            const token = json.choices[0]?.delta?.content || "";
            if (token) updateLastAssistantMessage(token);
          } catch (e) {
            // If JSON is incomplete, add it back to buffer (though pop should handle this)
            // But usually this happens if the line itself was split
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Generation stopped by user");
      } else {
        setError(err.message || "Something went wrong");
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  }

  // ── Logic ───────────────────────────────────────────────────────────────────
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex flex-col h-screen bg-brand-black text-slate-100 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-brand-mint/10 bg-brand-black-light/50 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl overflow-hidden shadow-lg shadow-brand-mint/10">
            <img src="/favicon.ico" alt="Sova Logo" className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="font-bold text-lg">AI Sova Support</h1>
            <p className="text-xs text-slate-400 font-mono">
              dev - <a href="https://x.com/kuznetsjeka" target="_blank" className="hover:text-brand-mint underline underline-offset-2 transition-colors">Kuznets</a>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-brand-black-light/80 px-3 py-1.5 rounded-full border border-white/5">
          <span className={`w-2 h-2 rounded-full ${kbReady ? 'bg-brand-mint animate-pulse' : kbError ? 'bg-red-500' : 'bg-amber-500'}`} />
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
            {kbReady ? "Ready" : kbError ? `Error: ${error || 'Fail'}` : "Loading..."}
          </span>
        </div>
      </header>

      {/* Chat Messages */}
      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 scrollbar-thin scrollbar-thumb-white/10"
        style={{ backgroundImage: "url('/back.png')", backgroundSize: 'cover', backgroundAttachment: 'fixed', backgroundPosition: 'center' }}
      >
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-20 h-20 bg-brand-mint/10 rounded-full flex items-center justify-center mb-6">
              <img src="/favicon.ico" alt="Sova" className="w-12 h-12" />
            </div>
            <p className="text-xl font-medium mb-2 text-white">How can I help you?</p>
            <p className="text-sm max-w-xs text-slate-300">Ask about fees, security, or how to start with Sova Protocol.</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex gap-4 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${m.role === "user" ? "bg-brand-mint text-brand-black" : "bg-brand-black-light border border-white/10"}`}>
              {m.role === "user" ? "U" : "AI"}
            </div>
            <div className={`flex flex-col gap-2 max-w-[85%] md:max-w-[70%] ${m.role === "user" ? "items-end" : "items-start"}`}>
              <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${m.role === "user" ? "bg-brand-mint text-brand-black rounded-tr-none font-medium" : "bg-brand-black-light border border-white/5 rounded-tl-none"}`}>
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown
                    components={{
                      h3: ({ ...props }) => <h3 className="text-brand-mint font-bold mt-4 mb-2" {...props} />,
                      p: ({ ...props }) => <p className="mb-2 last:mb-0" {...props} />,
                      ul: ({ ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                      ol: ({ ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                      li: ({ ...props }) => <li className="mb-1 ml-1" {...props} />,
                      strong: ({ ...props }) => <strong className="font-bold text-brand-mint" {...props} />,
                      em: ({ ...props }) => <em className="italic text-brand-mint/90" {...props} />,
                    }}
                  >
                    {m.content
                      // 1. Force bold labels in lists: "- Label: description" -> "- **Label**: description"
                      .replace(/^([-*•])\s+([A-Za-z\s]+):/gm, '$1 **$2**:')

                      // 2. Bold stray labels: "Label: description" at start of line
                      .replace(/^([A-Z][A-Za-z\s]+):(?!\/)/gm, '**$1**:')

                      // 3. Force a blank line before list items if they follow text
                      .replace(/([.!?])\s*\n([-*•])/g, '$1\n\n$2')

                      // 4. Remove stray asterisks after colons
                      .replace(/:(\*)/g, ':')
                    }
                  </ReactMarkdown>
                </div>
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {m.sources.map(s => (
                    <a key={s} href={s} target="_blank" className="text-[10px] bg-brand-black-light hover:bg-brand-mint/10 border border-white/10 px-2 py-1 rounded-md text-slate-400 hover:text-brand-mint transition-all">
                      {new URL(s).pathname.split('/').pop()?.replace('.md', '') || "docs"}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && abortControllerRef.current && (
          <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2">
            <div className="w-8 h-8 rounded-full bg-brand-black-light border border-white/10 flex items-center justify-center text-xs shrink-0">AI</div>
            <div className="bg-brand-black-light border border-white/5 px-4 py-3 rounded-2xl rounded-tl-none">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 bg-brand-mint rounded-full animate-bounce" />
                <span className="w-1.5 h-1.5 bg-brand-mint rounded-full animate-bounce [animation-delay:0.2s]" />
                <span className="w-1.5 h-1.5 bg-brand-mint rounded-full animate-bounce [animation-delay:0.4s]" />
              </span>
            </div>
          </div>
        )}
      </main>

      {/* Error & Controls */}
      <footer className="p-4 border-t border-brand-mint/10 bg-brand-black-light/50 backdrop-blur-md">
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => sendMessage()} className="underline font-bold">Try again</button>
          </div>
        )}

        <div className="max-w-6xl mx-auto flex items-center gap-3 w-full">
          <img src="/sova1.webp" alt="" className="hidden lg:block w-24 h-24 object-contain shrink-0" />

          <div className="flex-1 relative bg-brand-black-light rounded-2xl border border-white/5 focus-within:border-brand-mint/50 transition-colors shadow-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about Sova documentation..."
              className="w-full bg-transparent border-none text-sm px-4 py-3 pb-8 focus:ring-0 resize-none overflow-hidden"
              style={{ height: 'auto' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />
            <div className="absolute bottom-2 right-4 text-[10px] text-slate-500 font-mono">
              {input.length} / {MAX_INPUT_LENGTH}
            </div>
          </div>

          <div className="flex gap-2">
            {loading ? (
              <button
                onClick={stopGeneration}
                className="w-12 h-12 bg-brand-black-light border border-brand-mint/30 hover:border-brand-mint/50 rounded-xl flex items-center justify-center transition-all shadow-lg"
                title="Stop generation"
              >
                <div className="w-3 h-3 bg-brand-mint rounded-sm" />
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim() || !kbReady}
                className="w-12 h-12 bg-brand-mint hover:bg-brand-mint-dark disabled:opacity-30 rounded-xl flex items-center justify-center transition-all shadow-lg shadow-brand-mint/20"
              >
                <svg className="w-5 h-5 text-brand-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            )}
          </div>

          <img src="/sova2.webp" alt="" className="hidden lg:block w-24 h-24 object-contain shrink-0" />
        </div>
      </footer>
    </div>
  );
}
