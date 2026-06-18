import { env } from "../env";
import { ApiError } from "../lib/http";

export interface AnalyzedActionItem {
  title: string;
  assignee: string;
  description: string;
  priority: "High" | "Medium" | "Low";
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

EXTRACTION RULES — enterprise users need completeness and correct ownership:

ACTION ITEMS — extract EVERY commitment, assignment, and follow-up:
- Include implicit tasks ("I'll check", "I'll follow up internally"), escalations ("escalate to me if not resolved by Friday"), and notifications ("I'll inform Kevin").
- ASSIGNEE must be the EXACT person who owns the task. If someone says "I'll do X", the assignee is that speaker. If a person is named ("Kevin should lead it", "Emily publishes by Friday"), use that name. Do not guess a plausible owner — attribute to who actually committed.
- Ownership transfers: when work moves from person A to person B, the task's assignee is B; ALSO emit a separate notification task for whoever agreed to inform B (e.g. "Notify Kevin of ownership change", assignee = the person who said they'd tell Kevin).
- Use "Unassigned" only when the owner is genuinely unstated.

KEY DECISIONS — concrete decisions the group settled on, distinct from open discussion (e.g. "Reporting work is paused", "Performance prioritized over executive dashboards").

RISKS — concerns, blockers, and threats raised (security gaps, performance problems, schedule slips, disputes, capacity limits). Capture each distinct risk.

DEPENDENCIES — blocking relationships and required ordering. When there is a chain (A is blocked by B is blocked by C), express each link as its own clear statement.

BLOCKERS — the most pressing impediments CURRENTLY stopping progress. This is the actionable "what's stuck right now" view, distinct from dependencies (which describe sequencing): include missing inputs, unresolved disputes, postponed prerequisites, and process blockers. Phrase each as a short, specific red-flag statement. Use [] if nothing is actively blocked.

OPEN QUESTIONS — important questions that were explicitly raised but left UNANSWERED or unresolved by the meeting's end. Phrase each as the question itself. Use [] if none.

BLOCKED BY (per task) — for each action item, set "blockedBy" to the EXACT titles of OTHER action items in this same list that must finish before it can start. Use [] when nothing blocks it. Only reference titles that appear in actionItems, so the board can show blockers on each card.

GENERAL:
- priority must be exactly one of: "High", "Medium", "Low".
- Every array must be present (use [] if nothing applies).
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
    console.error("NVIDIA API request failed:", err);
    throw new ApiError(502, "Failed to reach the AI service. Please try again.");
  }

  const choice = responseBody?.choices?.[0];
  let text: string | undefined = choice?.message?.content;

  if (!text) {
    throw new ApiError(502, "The AI returned an empty response. Please try again.");
  }

  // The model may wrap JSON in markdown code fences — strip them.
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // If thinking mode is enabled, the model may prefix with <think>…</think> — strip it.
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();

  let parsed: TranscriptAnalysis;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("AI returned malformed JSON:", text.slice(0, 500));
    throw new ApiError(502, "The AI returned malformed data. Please try again.");
  }

  // Defensive defaults in case the model omits arrays.
  parsed.keyDecisions ??= [];
  parsed.actionItems ??= [];
  parsed.risks ??= [];
  parsed.dependencies ??= [];
  parsed.blockers ??= [];
  parsed.openQuestions ??= [];
  return parsed;
}
