/**
 * Shared prompts for local + cloud form-question answering.
 */

export function buildSystemPrompt(fieldType) {
  const lengthHint =
    fieldType === "textarea"
      ? "Write 2-3 sentences."
      : "Write one short sentence (under 120 characters if possible).";

  return (
    "You fill out Luma event registration forms. " +
    `${lengthHint} ` +
    "Answer ONLY the question asked — do not repeat the question. " +
    "Be specific, professional, and authentic. Use ONLY the profile facts provided. " +
    "Do NOT invent URLs, social handles, usernames, phone numbers, employers, dates, or statistics " +
    "that are not in the profile — if a detail is unknown, give a brief honest generic answer instead of guessing. " +
    "For location/city questions use the profile location. " +
    "For community membership questions, answer honestly and positively. " +
    "For admission questions, give a concise compelling reason tied to their background. " +
    "Never mention AI. No quotes around the answer."
  );
}

/** System prompt for choosing one option from a fixed list (constrained selection). */
export function buildOptionSelectSystemPrompt() {
  return (
    "You help an attendee fill a Luma event registration form. " +
    "You are given a question and a numbered list of the ONLY allowed answers. " +
    "Choose the single best option for the attendee based on their profile. " +
    "Reply with ONLY the number of that option — no words, no punctuation, no explanation. " +
    "Never invent an answer that is not in the list."
  );
}

export function buildOptionSelectUserPrompt({ question, options, profile = {}, eventTitle }) {
  const list = (options || []).map((o, i) => `${i + 1}. ${o}`).join("\n");
  return (
    `Event: ${eventTitle || "SF tech / AI community event"}\n` +
    `Question: ${question}\n\n` +
    `Attendee profile:\n` +
    `- Name: ${profile.first_name || ""} ${profile.last_name || ""}\n` +
    `- Title: ${profile.job_title || ""}\n` +
    `- Company: ${profile.company || ""}\n` +
    `- Location: ${profile.location || "San Francisco, CA"}\n\n` +
    `Options:\n${list}\n\n` +
    `Reply with the number of the single best option:`
  );
}

/**
 * Map a model reply back to one of the real option strings.
 * Accepts a 1-based number, an exact (case-insensitive) match, or a contained match.
 * Returns null when nothing maps cleanly so the caller can fall back deterministically.
 */
export function parseOptionChoice(raw, options) {
  if (raw == null || !Array.isArray(options) || !options.length) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const numMatch = text.match(/\d+/);
  if (numMatch) {
    const idx = parseInt(numMatch[0], 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  const lower = text.toLowerCase();
  const exact = options.find((o) => String(o).toLowerCase() === lower);
  if (exact) return exact;

  if (lower.length >= 3) {
    const contained = options.find((o) => {
      const ol = String(o).toLowerCase();
      return ol.length >= 3 && (lower.includes(ol) || ol.includes(lower));
    });
    if (contained) return contained;
  }

  return null;
}

export function buildUserPrompt({ question, profile, eventTitle, fieldType }) {
  const defaults = profile.default_answers || {};
  const saved = Object.entries(defaults)
    .slice(0, 6)
    .map(([q, a]) => `- ${q}: ${a}`)
    .join("\n");

  return (
    `Event: ${eventTitle || "SF tech / AI community event"}\n` +
    `Question: ${question}\n` +
    `Field type: ${fieldType || "text"}\n\n` +
    `Profile:\n` +
    `- Name: ${profile.first_name} ${profile.last_name}\n` +
    `- Title: ${profile.job_title}\n` +
    `- Company: ${profile.company}\n` +
    `- Location: ${profile.location || "San Francisco, CA"}\n` +
    `- LinkedIn: ${profile.linkedin || "n/a"}\n` +
    (saved ? `\nSaved answers:\n${saved}` : "")
  );
}

export function buildChatPrompt(system, user) {
  return (
    `<|im_start|>system\n${system}\n` +
    `<|im_start|>user\n${user}\n` +
    `<|im_start|>assistant\n`
  );
}

export function trimAnswer(text, fieldType) {
  let answer = (text || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/<\|im_end\|>/)[0]
    .split("<|im_start|>")[0]
    .trim();
  if (fieldType !== "textarea" && answer.length > 280) {
    const cut = answer.slice(0, 277);
    const lastSpace = cut.lastIndexOf(" ");
    answer = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return answer;
}

export function ruleBasedFallback(profile, qType) {
  const loc = profile.location || "San Francisco, CA";
  switch (qType) {
    case "location":
    case "city":
      return loc;
    case "community_member":
      return "Yes — I'm active in the San Francisco tech community and excited to participate.";
    case "admission":
      return (
        `As a ${profile.job_title} at ${profile.company}, I bring hands-on full-stack and AI experience ` +
        "and would contribute thoughtfully while learning from the community."
      );
    case "motivation":
      return (
        `I'm a ${profile.job_title} based in ${loc}, interested in AI/tech events ` +
        "where I can learn and meet other developers."
      );
    default:
      return null;
  }
}
