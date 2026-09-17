/**
 * Which of an event's registration questions (from the Luma /url lookup) need the on-device
 * model. Those are answered ahead of time — while the previous form fills or the next page
 * preloads — so the answers are already cached when the form opens.
 *
 * Only free-text questions the profile cannot answer deterministically qualify. The label rules
 * here mirror the identity rules in lib/form-intelligence.js closely enough: a mismatch only
 * costs a wasted or missed pre-answer, never a wrong fill, because the cache is consulted solely
 * on the model path and keyed by the exact question text.
 */
export const FREE_TEXT_TYPES = new Set(["text", "long-text", "long_text", "textarea", "paragraph", "short-text", "short_text"]);

const PROFILE_ANSWERED = [
  /\b(first|last|full) ?name\b|^name$|your name/i,
  /e-?mail/i,
  /\b(phone|mobile|tel|telephone|cell|whatsapp)\b/i,
  /linkedin|github|twitter|\bx handle\b|x \(twitter\)|instagram|website|portfolio|\burl\b|\blinks?\b/i,
  /company|organi[sz]ation|employer|school|university|institution|work or study|where do you work/i,
  /job title|current role|role or title|title\/role|what is your role|what('s| is) your (current )?(title|position)/i,
  /\bcity\b|location|where are you based|based in/i,
  /how did you (hear|find)|where did you hear|referral/i,
  /dietary|allerg|food/i,
  /how many|number of employees|team size|company size|headcount|size of/i,
  /raised|funding|capital/i,
  /agree|consent|acknowledge|code of conduct|terms|waiver/i,
  /gender|^sex$/i,
  /\bbook\b/i,
];

const ABOUT_OTHERS = /\b(their|who else|invite|teammates?|team members?|list (the )?names?)\b/i;

export function isModelQuestion(question = {}) {
  const type = String(question.question_type || question.type || "text").toLowerCase();
  const label = String(question.label || question.question || "").trim();
  if (!label || !FREE_TEXT_TYPES.has(type)) return false;
  if (Array.isArray(question.options) && question.options.length) return false;
  if (ABOUT_OTHERS.test(label)) return true;
  return !PROFILE_ANSWERED.some((re) => re.test(label));
}

/** Questions worth pre-answering, required ones first, capped so a long form cannot hog the model. */
export function pickPrewarmQuestions(questions = [], max = 4) {
  const picked = (Array.isArray(questions) ? questions : [])
    .filter(isModelQuestion)
    .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  return picked.slice(0, max).map((q) => ({
    label: String(q.label || q.question).trim(),
    type: String(q.question_type || q.type || "text").toLowerCase(),
    required: Boolean(q.required),
  }));
}
