import { buildBackgroundAnswer } from "./profile.js";
import { pickAnswerForQuestion, smartPlaceholderAnswers } from "./smartAnswers.js";

const LANGUAGE_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

let languageModelSession = null;

function buildPrompt({ profile, eventContext, questions }) {
  const questionBlock = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

  return `You fill Luma event registration forms. Write a UNIQUE, specific answer for EACH question below.
Rules:
- 1-3 sentences per answer, natural tone, first person
- NEVER repeat the same answer twice — each answer must directly address that question
- For team size questions: give a realistic team size
- For tech stack / platform questions: list specific technologies and tools
- Use the event and applicant context when relevant
- Do not mention AI or that you are an assistant
- Return ONLY valid JSON

Event: ${eventContext.title || "Unknown event"}
${eventContext.description ? `Event description: ${eventContext.description}` : ""}

Applicant:
- Name: ${profile.name}
- Title: ${profile.title || "Software Engineer"}
- Company: ${profile.company || "N/A"}
- Team size: ${profile.teamSize || "Small team (~5-10)"}
- Tech stack: ${profile.techStack || "TypeScript, Python, React, AWS"}
- Bio: ${profile.bio || buildBackgroundAnswer(profile)}
- Why attending: ${profile.whyAttend}
- Referral source: ${profile.referralSource || "Luma"}

Questions (answer each differently):
${questionBlock}

JSON format:
{"answers":["answer 1","answer 2"]}`;
}

function parseAnswers(rawText, count) {
  const text = String(rawText || "").trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.answers)) {
        return parsed.answers.slice(0, count).map((a) => String(a || "").trim());
      }
    } catch {
      // fall through
    }
  }

  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\d+[\).\s-]+/, "").trim())
    .filter(Boolean);

  if (lines.length >= count) return lines.slice(0, count);
  return lines.concat(Array(Math.max(0, count - lines.length)).fill("")).slice(0, count);
}

async function isSlmReady() {
  if (typeof LanguageModel === "undefined") return false;
  try {
    const availability = await LanguageModel.availability(LANGUAGE_OPTIONS);
    return availability === "available";
  } catch {
    return false;
  }
}

async function promptChromeLanguageModel(prompt) {
  if (!(await isSlmReady())) {
    return { ok: false, reason: "chrome_ai_not_ready" };
  }

  if (!languageModelSession) {
    try {
      languageModelSession = await Promise.race([
        LanguageModel.create(LANGUAGE_OPTIONS),
        new Promise((_, reject) => setTimeout(() => reject(new Error("create_timeout")), 5000)),
      ]);
    } catch {
      return { ok: false, reason: "chrome_ai_create_failed" };
    }
  }

  try {
    const result = await Promise.race([
      languageModelSession.prompt(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
    return { ok: true, text: result, provider: "chrome-gemini-nano" };
  } catch {
    return { ok: false, reason: "chrome_ai_timeout" };
  }
}

async function promptGeminiApi(prompt, apiKey, model) {
  if (!apiKey) return { ok: false, reason: "missing_api_key" };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 1500 },
      }),
    }
  );

  if (!response.ok) {
    return { ok: false, reason: `gemini_api_${response.status}` };
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return { ok: true, text, provider: "gemini-api" };
}

export async function answerRegistrationQuestions({ profile, eventContext, questions, settings }) {
  if (!questions.length) {
    return { ok: true, answers: [], provider: "none" };
  }

  const smartFallback = smartPlaceholderAnswers(questions, profile, eventContext);
  const useAi = settings?.aiAnswerQuestions !== false;

  if (useAi && (await isSlmReady() || settings?.geminiApiKey)) {
    const prompt = buildPrompt({ profile, eventContext, questions });
    let result = await promptChromeLanguageModel(prompt);

    if (!result.ok && settings?.geminiApiKey) {
      result = await promptGeminiApi(prompt, settings.geminiApiKey, settings.geminiModel);
    }

    if (result.ok) {
      const answers = parseAnswers(result.text, questions.length);
      const filled = answers.map(
        (answer, i) => answer || smartFallback[i] || pickAnswerForQuestion(questions[i], profile, eventContext)
      );
      return { ok: true, answers: filled, provider: result.provider };
    }
  }

  return {
    ok: true,
    answers: smartFallback,
    provider: "smart-rules",
    fallbackReason: useAi ? "slm_unavailable" : "ai_disabled",
  };
}

export async function checkAiAvailability(settings) {
  if (await isSlmReady()) {
    return { available: true, provider: "chrome-gemini-nano", status: "available" };
  }

  if (typeof LanguageModel !== "undefined") {
    try {
      const availability = await LanguageModel.availability(LANGUAGE_OPTIONS);
      if (availability !== "unavailable") {
        return { available: false, provider: "smart-rules", status: availability, hint: "Smart rules active until SLM is ready." };
      }
    } catch {
      // continue
    }
  }

  if (settings.geminiApiKey) {
    return { available: true, provider: "gemini-api", status: "api_key_set" };
  }

  return { available: true, provider: "smart-rules", status: "rule_based_answers_always_available" };
}

export function destroyLanguageModelSession() {
  if (languageModelSession) {
    languageModelSession.destroy?.();
    languageModelSession = null;
  }
}

export { pickAnswerForQuestion, smartPlaceholderAnswers };
