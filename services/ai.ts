import { env } from "../env";
import { ApiError } from "../lib/http";

export interface AnalyzedActionItem {
  title: string;
  assignee: string;
  description: string;
  priority: "High" | "Medium" | "Low";
}

export interface TranscriptAnalysis {
  summary: string;
  keyDecisions: string[];
  sentimentInfo: { score: string; breakdown: string };
  actionItems: AnalyzedActionItem[];
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

const SYSTEM_PROMPT = `You are a meeting analyst. Analyze the provided transcript and return a JSON object with exactly this structure (no markdown fences, no extra text — only raw JSON):

{
  "summary": "A concise summary of the meeting's content and context.",
  "keyDecisions": ["Decision 1", "Decision 2"],
  "sentimentInfo": {
    "score": "Positive | Neutral | Negative",
    "breakdown": "Brief explanation of sentiment trends."
  },
  "actionItems": [
    {
      "title": "Short actionable title",
      "assignee": "Person name or 'Unassigned'",
      "description": "Detailed description of what needs to be done.",
      "priority": "High | Medium | Low"
    }
  ]
}

Rules:
- Set assignee to "Unassigned" if the responsible person is unknown.
- keyDecisions must be clearly distinguishable from general discussion.
- priority must be exactly one of: "High", "Medium", "Low".
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
  return parsed;
}
