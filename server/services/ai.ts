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

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// Models to try, in order. The first is the one the owner chose. NVIDIA
// retires hosted models without notice (the original, minimaxai/minimax-m3,
// started answering 410 Gone), so the rest are fallbacks. Override the whole
// list with NVIDIA_MODELS (comma-separated).
const DEFAULT_MODELS = [
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3-super-120b-a12b",
];

// Extra request fields per model family. DeepSeek reasons before it answers;
// left on, the reasoning took about three minutes per transcript and sometimes
// used the whole max_tokens budget, leaving an empty reply. With it off the
// same transcripts took about 70 seconds and always produced a reply.
const MODEL_EXTRAS: { prefix: string; fields: Record<string, unknown> }[] = [
  {
    prefix: "deepseek-ai/",
    fields: { chat_template_kwargs: { thinking: false, enable_thinking: false } },
  },
];

const extrasFor = (model: string): Record<string, unknown> =>
  MODEL_EXTRAS.find((m) => model.startsWith(m.prefix))?.fields ?? {};

// One model gets this long before we move on to the next.
const MODEL_TIMEOUT_MS = 240_000;

function getModels(): string[] {
  const configured = (env.NVIDIA_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
}

function getApiKey(): string {
  if (!env.NVIDIA_API_KEY) {
    throw new ApiError(
      503,
      "AI analysis is not configured. Set NVIDIA_API_KEY on the server.",
    );
  }
  return env.NVIDIA_API_KEY;
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

/** Why one model's attempt failed, and whether the next model is worth trying. */
class ModelAttemptError extends Error {
  constructor(
    message: string,
    /** False when the problem is ours (bad key, no access), not the model's. */
    readonly tryNext: boolean,
    /** What the user is told if every attempt fails this way. */
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

/** Ask one model for the analysis. Throws ModelAttemptError on any failure. */
async function analyzeWith(
  model: string,
  apiKey: string,
  transcript: string,
): Promise<TranscriptAnalysis> {
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
    res = await fetch(NVIDIA_API_URL, {
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
      true,
      "Failed to reach the AI service. Please try again.",
    );
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    // 401 and 403 mean the key is wrong or lacks access: another model will
    // not help. Everything else (retired model, overload, bad gateway) might.
    const ours = res.status === 401 || res.status === 403;
    throw new ModelAttemptError(
      `HTTP ${res.status}: ${errorText.slice(0, 300)}`,
      !ours,
      ours
        ? "The AI service rejected the server's API key. Ask the site owner to check NVIDIA_API_KEY."
        : `AI service returned an error (${res.status}). Please try again.`,
    );
  }

  const body: any = await res.json().catch(() => null);
  const text: unknown = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new ModelAttemptError(
      "empty reply",
      true,
      "The AI returned an empty response. Please try again.",
    );
  }

  try {
    return normalizeAnalysis(extractJson(text));
  } catch (err) {
    throw new ModelAttemptError(
      `unusable reply (${err instanceof Error ? err.message : String(err)}): ${text.slice(0, 300)}`,
      true,
      "The AI returned malformed data. Please try again.",
    );
  }
}

/**
 * Send a transcript to an NVIDIA-hosted model and return the structured
 * meeting analysis. Models are tried in order until one gives a usable reply.
 */
export async function analyzeTranscript(
  transcript: string,
): Promise<TranscriptAnalysis> {
  const apiKey = getApiKey();
  const models = getModels();

  let last: ModelAttemptError | undefined;
  for (const model of models) {
    try {
      const analysis = await analyzeWith(model, apiKey, transcript);
      if (last) console.warn(`AI analysis succeeded with fallback model ${model}`);
      return analysis;
    } catch (err) {
      if (!(err instanceof ModelAttemptError)) throw err;
      console.error(`AI model ${model} failed: ${err.message}`);
      last = err;
      if (!err.tryNext) break;
    }
  }

  throw new ApiError(502, last?.userMessage ?? "AI analysis failed. Please try again.");
}
