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

// Give up on a reply that takes longer than this, so a stalled call cannot hold
// a request (and the transcription reserved for it) open indefinitely.
const AI_TIMEOUT_MS = 120_000;

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

/** Send a transcript to MiniMax M3 (via NVIDIA) and return the structured meeting analysis. */
export async function analyzeTranscript(
  transcript: string,
): Promise<TranscriptAnalysis> {
  const apiKey = getApiKey();

  const payload = {
    model: "minimaxai/minimax-m3",
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
    chat_template_kwargs: { thinking_mode: "enabled" },
  };

  let responseBody: any;
  try {
    const res = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      console.error(`NVIDIA API error ${res.status}: ${errorText}`);
      throw new ApiError(
        502,
        `AI service returned an error (${res.status}). Please try again.`,
      );
    }

    responseBody = await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ApiError(
        504,
        "The AI took too long to answer. Try again, or use a shorter transcript.",
      );
    }
    console.error("NVIDIA API request failed:", err);
    throw new ApiError(502, "Failed to reach the AI service. Please try again.");
  }

  const choice = responseBody?.choices?.[0];
  const reply: unknown = choice?.message?.content;

  if (typeof reply !== "string" || !reply.trim()) {
    throw new ApiError(502, "The AI returned an empty response. Please try again.");
  }

  let data: unknown;
  try {
    data = JSON.parse(extractJson(reply));
  } catch {
    console.error("AI returned malformed JSON:", reply.slice(0, 500));
    throw new ApiError(
      502,
      choice?.finish_reason === "length"
        ? "The AI ran out of room before it finished. Try a shorter transcript."
        : "The AI returned malformed data. Please try again.",
    );
  }

  return normalizeAnalysis(data);
}

/**
 * The JSON object inside a reply. The model is told to answer with bare JSON,
 * but it may put its reasoning in <think> tags first and wrap the object in a
 * code fence, in any combination. Dropping the reasoning and cutting from the
 * first "{" to the last "}" covers all of them.
 */
function extractJson(reply: string): string {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text.trim();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The product writes no long dashes, but the model sometimes does. A dash
 * between two numbers becomes a hyphen; any other becomes a comma.
 */
const plainDashes = (value: string): string =>
  value
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/^,\s*|,\s*$/g, "");

/** A trimmed string no longer than `max`, or "" for anything that is not text. */
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? plainDashes(value.trim()).slice(0, max).trim() : "";

/** A list of non-empty strings, or [] for anything that is not a list. */
const list = (value: unknown, maxItems = 40, maxLength = 600): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => text(entry, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

// Words the model uses for a priority, mapped to the three the board knows.
const PRIORITY_WORDS: Record<string, Priority> = {
  high: "High",
  urgent: "High",
  critical: "High",
  highest: "High",
  medium: "Medium",
  normal: "Medium",
  moderate: "Medium",
  low: "Low",
  minor: "Low",
  lowest: "Low",
};

/**
 * Turn whatever the model sent into the exact shape the board stores. Missing
 * or mistyped parts fall back to safe values, so one odd field cannot fail the
 * whole analysis; a reply with no summary at all is rejected.
 */
function normalizeAnalysis(data: unknown): TranscriptAnalysis {
  const incomplete = () =>
    new ApiError(502, "The AI returned an incomplete analysis. Please try again.");
  if (!isRecord(data)) throw incomplete();

  const summary = text(data.summary, 4000);
  if (!summary) throw incomplete();

  const sentiment = isRecord(data.sentimentInfo) ? data.sentimentInfo : {};

  const actionItems: AnalyzedActionItem[] = (
    Array.isArray(data.actionItems) ? data.actionItems : []
  )
    .filter(isRecord)
    .map((item) => ({
      title: text(item.title, 300),
      assignee: text(item.assignee, 120) || "Unassigned",
      description: text(item.description, 5000),
      priority: PRIORITY_WORDS[text(item.priority, 20).toLowerCase()] ?? null,
      blockedBy: list(item.blockedBy, 20, 300),
    }))
    .filter((item) => item.title)
    .slice(0, 100);

  // A task can only wait on another task in this list, named by its exact title.
  const titles = new Map(actionItems.map((item) => [item.title.toLowerCase(), item.title]));
  for (const item of actionItems) {
    const known = item.blockedBy
      .map((title) => titles.get(title.toLowerCase()))
      .filter((title): title is string => !!title && title !== item.title);
    item.blockedBy = [...new Set(known)];
  }

  return {
    summary,
    keyDecisions: list(data.keyDecisions),
    sentimentInfo: {
      score: text(sentiment.score, 40) || "Neutral",
      breakdown: text(sentiment.breakdown, 1000),
    },
    actionItems,
    risks: list(data.risks),
    dependencies: list(data.dependencies),
    blockers: list(data.blockers),
    openQuestions: list(data.openQuestions),
  };
}
