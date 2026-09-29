// Task → ordered fallback chain of {provider, model} steps.
// Step 0 for every task is the admin-configured Gemini primary model
// (default: Gemini 3.1 flash-lite). The router only walks past it once every
// key in the Gemini pool is exhausted / cooling for that model.
// First success wins. When every step is exhausted the router surfaces AiBusyError.

import type { ProviderId, ProvidersConfig, CustomChainsConfig } from "./ai-providers.server";

export type ChainStep = { provider: ProviderId; model: string };
export type TaskChain = ChainStep[];


// ---- Reusable per-provider ladders -----------------------------------------

const GROQ_MICRO: ChainStep[] = [
  { provider: "groq", model: "openai/gpt-oss-20b" },
];
const GROQ_STRONG: ChainStep[] = [
  { provider: "groq", model: "qwen/qwen3.6-27b" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
];

const GEMINI_MICRO: ChainStep[] = [
  { provider: "gemini", model: "gemini-flash-lite-latest" },   // 3.x — 500 RPD
  { provider: "gemini", model: "gemini-2.5-flash-lite" },      // 1000 RPD
];
const GEMINI_STRONG: ChainStep[] = [
  { provider: "gemini", model: "gemini-2.5-flash" },
  { provider: "gemini", model: "gemini-2.5-pro" },
];
const GEMINI_GEMMA: ChainStep[] = [
  { provider: "gemini", model: "gemma-3-27b-it" },
  { provider: "gemini", model: "gemma-3-12b-it" },
  { provider: "gemini", model: "gemma-3-4b-it" },
];

const NVIDIA_JSON: ChainStep[] = [
  { provider: "nvidia", model: "meta/llama-3.3-70b-instruct" },
  { provider: "nvidia", model: "meta/llama-3.1-8b-instruct" },
];
const NVIDIA_CHAT: ChainStep[] = [
  { provider: "nvidia", model: "meta/llama-3.3-70b-instruct" },
  { provider: "nvidia", model: "mistralai/mixtral-8x7b-instruct-v0.1" },
];

const OPENROUTER_ANY: ChainStep[] = [
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "openai/gpt-oss-120b:free" },
];

const MISTRAL_SMALL: ChainStep[] = [
  { provider: "mistral", model: "ministral-3b-latest" },
  { provider: "mistral", model: "ministral-8b-latest" },
  { provider: "mistral", model: "mistral-small-latest" },
];
const MISTRAL_LARGE: ChainStep[] = [
  { provider: "mistral", model: "mistral-large-latest" },
  ...MISTRAL_SMALL,
];

const CHAIN_EXTRACT_QBANK: TaskChain = [
  ...GROQ_STRONG,
  { provider: "nvidia", model: "meta/llama-3.3-70b-instruct" },
  { provider: "huggingface", model: "meta-llama/Llama-3.3-70B-Instruct:novita" },
];

// ---- Chain compositions ----------------------------------------------------

const CHAIN_MICRO: TaskChain = [
  ...GROQ_MICRO,
  ...NVIDIA_CHAT,
  ...GEMINI_MICRO,
  ...GEMINI_GEMMA,
  ...OPENROUTER_ANY,
  ...MISTRAL_SMALL,
];

const CHAIN_JSON: TaskChain = [
  ...GROQ_STRONG,
  ...NVIDIA_JSON,
  ...GEMINI_MICRO,
  ...GEMINI_STRONG,
  ...GEMINI_GEMMA,
  ...OPENROUTER_ANY,
  ...MISTRAL_SMALL,
];

const CHAIN_CHAT: TaskChain = [
  ...GROQ_STRONG,
  ...NVIDIA_CHAT,
  ...GEMINI_MICRO,
  ...GEMINI_STRONG,
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  ...MISTRAL_SMALL,
];

const CHAIN_LONG_CONTEXT: TaskChain = [
  ...GEMINI_STRONG,        // 1M ctx
  ...GEMINI_MICRO,         // 1M ctx
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "openai/gpt-oss-120b:free" },
  ...GROQ_STRONG,
  ...MISTRAL_LARGE,
];

const CHAIN_REASONING: TaskChain = [
  ...GEMINI_STRONG,
  ...GROQ_STRONG,
  ...GEMINI_MICRO,
  { provider: "openrouter", model: "openai/gpt-oss-120b:free" },
  ...MISTRAL_LARGE,
];

// Active-recall grading: smartest models first (grading free text needs real
// judgement), then Gemini 3.1 Flash Lite served through OpenRouter (a
// non-Google provider) before any direct-Google step.
const CHAIN_GRADE: TaskChain = [
  ...GROQ_STRONG,
  { provider: "openrouter", model: "google/gemini-3.1-flash-lite" },
  ...GEMINI_STRONG,
  ...GEMINI_MICRO,
  ...MISTRAL_SMALL,
];

// ---- Task → chain map ------------------------------------------------------

export const TASK_CHAINS: Record<string, TaskChain> = {
  // QBank specific tasks
  chat_tutor: CHAIN_CHAT,
  explain_mcq: CHAIN_CHAT,
  qbank_flashcard_from_question: CHAIN_JSON,
  qbank_study_concept: CHAIN_CHAT,
  extract_qbank_questions: CHAIN_EXTRACT_QBANK,
};


export const TASK_LABELS: Record<string, string> = {
  chat_tutor: "AI Tutor Chat (General)",
  explain_mcq: "Explain MCQ Answer",
  qbank_flashcard_from_question: "Generate AI Flashcard",
  qbank_study_concept: "Study This Concept (Book Style)",
  extract_qbank_questions: "Extract QBank Questions",
};

export function chainFor(task?: string): TaskChain {
  if (task && TASK_CHAINS[task]) return TASK_CHAINS[task];
  return CHAIN_CHAT;
}

export function resolveChain(task: string | undefined, cfg?: ProvidersConfig | null, customChains?: CustomChainsConfig | null): TaskChain {
  if (task && customChains && customChains[task] && customChains[task].length > 0) {
    // If the admin has defined an explicit fallback chain for this exact task, use it exclusively.
    return customChains[task];
  }
  return chainFor(task);
}


// Minimal probe payload per task — used by the admin health checker.
export type Probe = { messages: { role: "user"; content: string }[]; requireJson: boolean; maxTokens: number };

const PROBE_PING: Probe = {
  messages: [{ role: "user", content: "ping" }],
  requireJson: false,
  maxTokens: 3,
};
const PROBE_JSON: Probe = {
  messages: [{ role: "user", content: 'Return {"ok":true} as JSON.' }],
  requireJson: true,
  maxTokens: 20,
};
const PROBE_SUMMARY: Probe = {
  messages: [{ role: "user", content: "Summarize: hello world" }],
  requireJson: false,
  maxTokens: 10,
};

export function probeFor(task: string): Probe {
  const chain = TASK_CHAINS[task];
  if (!chain) return PROBE_PING;

  // JSON tasks
  if (
    task === "qbank_flashcard_from_question" ||
    task === "extract_qbank_questions"
  ) return PROBE_JSON;
  return PROBE_PING;
}
