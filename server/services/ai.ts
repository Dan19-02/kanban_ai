import { env } from "../env";
import { ApiError } from "../lib/http";

export type Priority = "High" | "Medium" | "Low";

export interface AnalyzedActionItem {
  title: string;
  assignee: string;
  description: string;
  /** Null when the model gave no priority the board understands. */
  priority: Priority | null;
  /** Exact titles of other action items that must finish before this one. */
  blockedBy: string[];
}

export interface TranscriptAnalysis {
  summary: string;
  keyDecisions: string[];
  sentimentInfo: { score: string; breakdown: string };
  actionItems: AnalyzedActionItem[];
  /** Risks, concerns, and blockers raised in the meeting. */
  risks: string[];
  /** Blocking dependencies / required sequencing between work items. */
  dependencies: string[];
  /** Impediments currently stopping progress (the actionable "what's stuck"). */
  blockers: string[];
  /** Questions raised in the meeting that were left unanswered. */
  openQuestions: string[];
}

// Analysis can run on more than one host. Each is OpenAI-compatible; a host is
// used when its API key is set, and they are tried in this order.
//
// Measured with this prompt on the same two transcripts, DeepSeek V4.1 Flash
// with reasoning off answered in about 4 seconds on Nebius and about 70 seconds
// on NVIDIA, so Nebius goes first.
interface Provider {
  name: string;
  url: string;
  /** Name of the environment variable that holds the key (used in messages). */
  keyVar: "NEBIUS_API_KEY" | "NVIDIA_API_KEY";
  /** Name of the variable that overrides the model list. */
  modelsVar: "NEBIUS_MODELS" | "NVIDIA_MODELS";
  /** Models to try, in order, unless the override is set. */
  defaultModels: string[];
}

// NVIDIA retires hosted models without notice (the original and only model,
// minimaxai/minimax-m3, started answering 410 Gone), which is why there is a
// list and a second host rather than a single model.
const PROVIDERS: Provider[] = [
  {
    name: "Nebius",
    url: "https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions",
    keyVar: "NEBIUS_API_KEY",
    modelsVar: "NEBIUS_MODELS",
    defaultModels: ["deepseek-ai/DeepSeek-V4.1-Flash"],
  },
  {
    name: "NVIDIA",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    keyVar: "NVIDIA_API_KEY",
    modelsVar: "NVIDIA_MODELS",
    defaultModels: ["deepseek-ai/deepseek-v4.1-flash", "nvidia/nemotron-3-super-120b-a12b"],
  },
];

// Extra request fields per model family. DeepSeek reasons before it answers.
// Left on, the reasoning made replies several times slower and on NVIDIA
// sometimes used the whole max_tokens budget, leaving an empty reply. Owner
// attribution was as good with it off.
const MODEL_EXTRAS: { prefix: string; fields: Record<string, unknown> }[] = [
  {
    prefix: "deepseek-ai/",
    fields: { chat_template_kwargs: { thinking: false, enable_thinking: false } },
  },
];

const extrasFor = (model: string): Record<string, unknown> =>
  MODEL_EXTRAS.find((m) => model.toLowerCase().startsWith(m.prefix))?.fields ?? {};

// One model gets this long before we move on to the next.
const MODEL_TIMEOUT_MS = 240_000;

/** One host and model to ask. */
interface Target {
  provider: Provider;
  apiKey: string;
  model: string;
}

/** Every host and model to try, in order. Hosts without a key are left out. */
function getTargets(): Target[] {
  const targets: Target[] = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.keyVar];
    if (!apiKey) continue;
    const configured = (env[provider.modelsVar] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    for (const model of configured.length > 0 ? configured : provider.defaultModels) {
      targets.push({ provider, apiKey, model });
    }
  }
  if (targets.length === 0) {
    throw new ApiError(
      503,
      "AI analysis is not configured. Set NEBIUS_API_KEY or NVIDIA_API_KEY on the server.",
    );
  }
  return targets;
}

const SYSTEM_PROMPT = `You are an expert meeting analyst for an enterprise meeting-intelligence platform. Analyze the transcript and return ONLY a raw JSON object (no markdown, no code fences, no commentary) with EXACTLY this structure:

{
  "summary": "A concise summary of the meeting's content and context.",
  "keyDecisions": ["A concrete decision the group made"],
  "sentimentInfo": {
    "score": "Positive | Neutral | Negative",
    "breakdown": "Brief explanation of sentiment trends."
  },
  "actionItems": [
    {
      "title": "Short actionable title",
      "assignee": "Exact person responsible, or 'Unassigned'",
      "description": "What needs to be done, including any deadline mentioned.",
      "priority": "High | Medium | Low",
      "blockedBy": ["Exact title of another action item that must finish first"]
    }
  ],
  "risks": ["A risk, concern, or blocker raised"],
  "dependencies": ["A blocking dependency or required sequence, e.g. 'X cannot start until Y is done'"],
  "blockers": ["An impediment currently stopping progress, e.g. 'Migration testing blocked by missing mapping file'"],
  "openQuestions": ["A question raised but left unanswered, e.g. 'What are the final acquisition numbers?'"]
}

EXTRACTION RULES. Enterprise users need completeness and correct ownership:

ACTION ITEMS: extract EVERY commitment, assignment, and follow-up:
- Include implicit tasks ("I'll check", "I'll follow up internally"), escalations ("escalate to me if not resolved by Friday"), and notifications ("I'll inform Kevin").
- ASSIGNEE must be the EXACT person who owns the task. If someone says "I'll do X", the assignee is that speaker. If a person is named ("Kevin should lead it", "Emily publishes by Friday"), use that name. Do not guess a plausible owner; attribute to who actually committed.
- Ownership transfers: when work moves from person A to person B, the task's assignee is B; ALSO emit a separate notification task for whoever agreed to inform B (e.g. "Notify Kevin of ownership change", assignee = the person who said they'd tell Kevin).
- Use "Unassigned" only when the owner is genuinely unstated.

KEY DECISIONS: concrete decisions the group settled on, distinct from open discussion (e.g. "Reporting work is paused", "Performance prioritized over executive dashboards").

RISKS: concerns, blockers, and threats raised (security gaps, performance problems, schedule slips, disputes, capacity limits). Capture each distinct risk.

DEPENDENCIES: blocking relationships and required ordering. When there is a chain (A is blocked by B is blocked by C), express each link as its own clear statement.

BLOCKERS: the most pressing impediments CURRENTLY stopping progress. This is the actionable "what's stuck right now" view, distinct from dependencies (which describe sequencing): include missing inputs, unresolved disputes, postponed prerequisites, and process blockers. Phrase each as a short, specific red-flag statement. Use [] if nothing is actively blocked.

OPEN QUESTIONS: important questions that were explicitly raised but left UNANSWERED or unresolved by the meeting's end. Phrase each as the question itself. Use [] if none.

BLOCKED BY (per task): for each action item, set "blockedBy" to the EXACT titles of OTHER action items in this same list that must finish before it can start. Use [] when nothing blocks it. Only reference titles that appear in actionItems, so the board can show blockers on each card.

GENERAL:
- priority must be exactly one of: "High", "Medium", "Low".
- Every array must be present (use [] if nothing applies).
- Write plain sentences. Never use an em dash or an en dash; use a comma or a full stop instead.
- Return ONLY the JSON object. No markdown, no code fences, no explanation.`;

/** Why one attempt failed, and how much of the remaining list it rules out. */
class ModelAttemptError extends Error {
  constructor(
    message: string,
    /** True when the host rejected our key: its other models will fail too. */
    readonly skipProvider: boolean,
    /** What the user is told if every attempt fails and this was the last. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

/**
 * Pull the JSON object out of a model reply. Models wrap it in code fences,
 * prefix it with <think> blocks, or add a sentence before or after.
 */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];

/** Coerce a parsed reply into the shape the rest of the app relies on. */
export function normalizeAnalysis(parsed: unknown): TranscriptAnalysis {
  if (!parsed || typeof parsed !== "object") throw new Error("reply is not an object");
  const p = parsed as Record<string, any>;
  if (typeof p.summary !== "string" || p.summary.trim() === "") {
    throw new Error("reply has no summary");
  }

  const rawItems: any[] = Array.isArray(p.actionItems) ? p.actionItems : [];
  const actionItems: AnalyzedActionItem[] = rawItems
    .filter((i) => i && typeof i.title === "string" && i.title.trim() !== "")
    .map((i) => {
      const priority = String(i.priority ?? "").trim().toLowerCase();
      return {
        title: i.title.trim(),
        assignee:
          typeof i.assignee === "string" && i.assignee.trim() !== ""
            ? i.assignee.trim()
            : "Unassigned",
        description: typeof i.description === "string" ? i.description : "",
        priority: priority === "high" ? "High" : priority === "low" ? "Low" : "Medium",
        blockedBy: asStrings(i.blockedBy),
      };
    });

  // A task can only be blocked by another task on this board.
  const titles = new Set(actionItems.map((i) => i.title));
  for (const item of actionItems) {
    item.blockedBy = item.blockedBy.filter((t) => titles.has(t) && t !== item.title);
  }

  const sentiment = p.sentimentInfo && typeof p.sentimentInfo === "object" ? p.sentimentInfo : {};
  return {
    summary: p.summary.trim(),
    keyDecisions: asStrings(p.keyDecisions),
    sentimentInfo: {
      score: typeof sentiment.score === "string" && sentiment.score.trim() !== "" ? sentiment.score.trim() : "Neutral",
      breakdown: typeof sentiment.breakdown === "string" ? sentiment.breakdown : "",
    },
    actionItems,
    risks: asStrings(p.risks),
    dependencies: asStrings(p.dependencies),
    blockers: asStrings(p.blockers),
    openQuestions: asStrings(p.openQuestions),
  };
}

/** Ask one host and model for the analysis. Throws ModelAttemptError on any failure. */
async function analyzeWith(target: Target, transcript: string): Promise<TranscriptAnalysis> {
  const { provider, apiKey, model } = target;
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze the following meeting transcript:\n\n${transcript}`,
      },
    ],
    max_tokens: 8192,
    temperature: 0.2,
    top_p: 0.95,
    stream: false,
    ...extrasFor(model),
  };

  let res: Response;
  try {
    res = await fetch(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ModelAttemptError(
      `request failed: ${err instanceof Error ? err.message : String(err)}`,
      false,
      "Failed to reach the AI service. Please try again.",
    );
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    // 401 and 403 mean the key is wrong or lacks access, so this host's other
    // models will not help. Everything else (retired model, overload, bad
    // gateway) is about this one model.
    const keyRejected = res.status === 401 || res.status === 403;
    throw new ModelAttemptError(
      `HTTP ${res.status}: ${errorText.slice(0, 300)}`,
      keyRejected,
      keyRejected
        ? `The AI service rejected the server's API key. Ask the site owner to check ${provider.keyVar}.`
        : `AI service returned an error (${res.status}). Please try again.`,
    );
  }

  const body: any = await res.json().catch(() => null);
  const text: unknown = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new ModelAttemptError(
      "empty reply",
      false,
      "The AI returned an empty response. Please try again.",
    );
  }

  try {
    return normalizeAnalysis(extractJson(text));
  } catch (err) {
    throw new ModelAttemptError(
      `unusable reply (${err instanceof Error ? err.message : String(err)}): ${text.slice(0, 300)}`,
      false,
      "The AI returned malformed data. Please try again.",
    );
  }
}

/**
 * Send a transcript to a hosted model and return the structured meeting
 * analysis. Hosts and models are tried in order until one gives a usable reply.
 */
export async function analyzeTranscript(
  transcript: string,
): Promise<TranscriptAnalysis> {
  const targets = getTargets();

  let last: ModelAttemptError | undefined;
  const skipped = new Set<string>();
  for (const target of targets) {
    if (skipped.has(target.provider.name)) continue;
    const label = `${target.provider.name} ${target.model}`;
    try {
      const analysis = await analyzeWith(target, transcript);
      if (last) console.warn(`AI analysis succeeded with fallback: ${label}`);
      return analysis;
    } catch (err) {
      if (!(err instanceof ModelAttemptError)) throw err;
      console.error(`AI model failed (${label}): ${err.message}`);
      last = err;
      if (err.skipProvider) skipped.add(target.provider.name);
    }
  }

  throw new ApiError(502, last?.userMessage ?? "AI analysis failed. Please try again.");
}
