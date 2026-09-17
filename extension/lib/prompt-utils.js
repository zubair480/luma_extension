/**
 * Shared prompts for local + cloud form-question answering.
 */

export function buildSystemPrompt(fieldType) {
  const lengthHint =
    fieldType === "textarea"
      ? "Reply with at most two sentences, under 45 words in total."
      : "Reply with exactly one sentence, under 25 words.";

  return (
    "You are the attendee, writing one answer on an event registration form, in your own voice. " +
    `${lengthHint} ` +
    "Always write as \"I\" (never refer to the attendee by name or as he/she). Plain prose: no bullet " +
    "points, no lists, no headings, no quotes, no preamble, and do not repeat or define the question. " +
    "Answer the question directly: if it asks what you want to discuss, learn or find, say what you " +
    "want; if it asks what you are working on, say what you work on. " +
    "Use only the facts in the profile. Do not invent products, research areas, employers, " +
    "numbers, links or handles; if the profile does not cover the question, answer with what " +
    "you do at your company and what you want from this event. " +
    "Never mention being an assistant or a model."
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

  const about = [
    profile.job_title && profile.company ? `${profile.job_title} at ${profile.company}` : profile.job_title || profile.company,
    profile.location ? `based in ${profile.location}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    `Event: ${eventTitle || "a tech / AI community event"}\n` +
    `Attendee: ${profile.first_name} ${profile.last_name}, ${about || "attendee"}.\n` +
    (saved ? `Things the attendee has said before:\n${saved}\n` : "") +
    `\nForm question: ${question}\n` +
    `Answer (${fieldType === "textarea" ? "two sentences max" : "one sentence"}):`
  );
}

export function buildChatPrompt(system, user) {
  return (
    `<|im_start|>system\n${system}\n` +
    `<|im_start|>user\n${user}\n` +
    `<|im_start|>assistant\n`
  );
}

/**
 * Turn raw model output into form-ready text: strip chat markers, bullets and numbering, join
 * lines, keep whole sentences only (one for a text field, two for a textarea), drop repeats and
 * any unfinished tail. Returns "" when nothing usable remains.
 */
export function trimAnswer(text, fieldType) {
  let raw = (text || "")
    .split(/<\|im_end\|>/)[0]
    .split("<|im_start|>")[0]
    .replace(/^\s*(answer|response)\s*:\s*/i, "")
    .trim();
  if (!raw) return "";

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  let joined = lines
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])\1+/g, "$1")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  if (!joined) return "";
  // A reply that starts mid-sentence ("which is similar…") is a fragment, not an answer.
  if (!/^[A-Z0-9"'“(]/.test(joined)) {
    const firstProper = joined.search(/(?:^|[.!?]\s+)[A-Z]/);
    joined = firstProper >= 0 ? joined.slice(joined.indexOf(joined.match(/[A-Z]/)[0], firstProper)).trim() : "";
    if (!joined) return "";
  }

  const maxSentences = fieldType === "textarea" ? 2 : 1;
  const sentences = joined.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
  const seen = new Set();
  const kept = [];
  for (const s of sentences) {
    const clean = s.trim();
    const key = clean.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    kept.push(clean);
    if (kept.length >= maxSentences) break;
  }
  let answer = kept.join(" ");
  if (!answer) {
    // No sentence terminator at all: keep the text but cut it to a clean word boundary.
    const limit = fieldType === "textarea" ? 260 : 160;
    answer = joined.length > limit ? joined.slice(0, limit).replace(/\s+\S*$/, "") : joined;
  }
  const cap = fieldType === "textarea" ? 320 : 200;
  if (answer.length > cap) answer = answer.slice(0, cap).replace(/\s+\S*$/, "").replace(/[,;:]$/, "") + ".";
  return answer.trim();
}

export function ruleBasedFallback(profile, qType, { eventTitle = "", question = "" } = {}) {
  const loc = profile.location || "San Francisco, CA";
  const where = profile.company ? `${profile.job_title} at ${profile.company}` : profile.job_title;
  const event = eventTitle ? `"${eventTitle}"` : "this event";
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
      return `I'm a ${where} in ${loc}. I'm coming to ${event} to learn from the people building in this space and to meet other builders.`;
    case "building":
      return profile.company
        ? `${profile.job_title} at ${profile.company}, building AI products and tooling — happy to share more at the event.`
        : `${profile.job_title} building AI products and tooling — happy to share more at the event.`;
    default:
      return null;
  }
}
