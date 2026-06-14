/**
 * Run: node tests/run-tests.mjs
 * Tests smart answers + option matching before loading in Chrome.
 */
import { pickAnswerForQuestion, smartPlaceholderAnswers } from "../shared/smartAnswers.js";

const TEST_PROFILE = {
  name: "Zubair Zafar",
  email: "zubairzafar480@gmail.com",
  title: "Software Engineer",
  company: "Acme Labs",
  bio: "Software engineer building developer tools and AI workflows.",
  teamSize: "8 people across eng and support",
  techStack: "TypeScript, React, Node.js, PostgreSQL, Intercom, Zendesk",
  whyAttend: "I'm interested in connecting with the local community and learning from others in the space.",
  noQuestionsAnswer: "No questions at this time — looking forward to the event!",
  referralSource: "Found it while browsing events on Luma.",
  linkedin: "https://linkedin.com/in/zubairzafar",
  github: "https://github.com/zubairzafar",
};

const EVENT = {
  title: "SF AI Builders Meetup",
  description: "Talks on LLMs, agents, and video generation for developers.",
};

/** Real-style questions seen on Luma tech events */
const LUMA_TECH_QUESTIONS = [
  {
    q: "How big is your support team?",
    mustNotInclude: ["connecting with the local community"],
    mustInclude: ["8 people"],
  },
  {
    q: "What is your current tech stack / support platform?",
    mustNotInclude: ["connecting with the local community"],
    mustInclude: ["TypeScript", "Intercom"],
  },
  {
    q: "What is your biggest challenge working with video models?",
    mustInclude: ["consistency", "video"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "What are you most excited to learn from this event?",
    mustInclude: ["excited", "learn"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "Are you currently working with video generation models?",
    mustInclude: ["video"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "How did you hear about this event?",
    mustInclude: ["Luma"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "Tell us a little about yourself",
    mustInclude: ["Software Engineer"],
    mustNotInclude: [],
  },
  {
    q: "What are you hoping to get out of this event?",
    mustInclude: ["takeaways", "connections"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "Are you building with AI or LLMs today?",
    mustInclude: ["AI"],
    mustNotInclude: ["connecting with the local community"],
  },
  {
    q: "What's your GitHub username?",
    mustInclude: ["github.com"],
    mustNotInclude: [],
  },
  {
    q: "Do you have any questions for the speakers?",
    mustInclude: ["No questions"],
    mustNotInclude: [],
  },
  {
    q: "Why do you want to attend?",
    mustInclude: ["connecting with the local community"],
    mustNotInclude: [],
  },
];

/** Option matching (mirrors content/luma-agent.js logic) */
function scoreOptionText(optionText, terms) {
  const lower = String(optionText || "").trim().toLowerCase();
  if (!lower || lower === "select" || lower === "choose one") return 0;
  let score = 0;
  for (const term of terms) {
    if (lower === term) score += 100;
    else if (lower.includes(term)) score += term.length * 3;
    else if (term.includes(lower) && lower.length > 4) score += lower.length * 2;
  }
  return score;
}

function findBestOption(options, terms, profile) {
  let best = null;
  let bestScore = 0;
  for (const opt of options) {
    const score = scoreOptionText(opt, terms);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  if (best && bestScore > 0) return best;
  const fallbacks = ["software engineer", "engineering", "software", "developer", "tech"];
  const titleWords = (profile.title || "software engineer").toLowerCase().split(/\s+/);
  for (const opt of options) {
    const text = opt.toLowerCase();
    if ([...fallbacks, ...titleWords].some((t) => t.length > 3 && text.includes(t))) return opt;
  }
  return null;
}

const LUMA_OPTION_SCENARIOS = [
  {
    label: "Which best describes your role?",
    options: ["Founder", "Investor", "Software Engineer", "Designer", "Other"],
    expect: "Software Engineer",
  },
  {
    label: "What is your area of expertise?",
    options: ["Marketing", "Sales", "Software Engineering", "Finance", "Operations"],
    expect: "Software Engineering",
  },
  {
    label: "I am a…",
    options: ["Student", "Engineer", "Product Manager", "Researcher"],
    expect: "Engineer",
  },
  {
    label: "Experience level",
    options: ["Beginner", "Intermediate", "Senior Software Engineer", "Executive"],
    expect: "Senior Software Engineer",
  },
  {
    label: "Industry",
    options: ["Healthcare", "Technology / Software", "Finance", "Education"],
    expect: "Technology / Software",
  },
];

function getMatchTerms(profile, label = "") {
  const terms = new Set();
  const add = (p) => {
    if (!p?.trim()) return;
    const lower = p.toLowerCase().trim();
    terms.add(lower);
    lower.split(/\s+/).forEach((w) => w.length > 2 && terms.add(w));
  };
  add(profile.title);
  add(profile.company);
  if (profile.bio) add(profile.bio.slice(0, 100));
  ["software engineer", "engineering", "developer", "software", "tech", "technology"].forEach((t) => terms.add(t));
  if (/expertise|role|occupation|describe/i.test(label)) add(profile.title);
  return [...terms];
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

console.log("\n=== Smart answers (Luma tech events) ===\n");

const allAnswers = smartPlaceholderAnswers(
  LUMA_TECH_QUESTIONS.map((x) => x.q),
  TEST_PROFILE,
  EVENT
);
const uniqueAnswers = new Set(allAnswers);

assert(uniqueAnswers.size === LUMA_TECH_QUESTIONS.length, "Every question gets a unique answer");

for (let i = 0; i < LUMA_TECH_QUESTIONS.length; i += 1) {
  const { q, mustInclude, mustNotInclude } = LUMA_TECH_QUESTIONS[i];
  const answer = allAnswers[i];
  console.log(`\nQ: ${q}`);
  console.log(`A: ${answer.slice(0, 120)}${answer.length > 120 ? "…" : ""}`);

  assert(Boolean(answer?.trim()), "Answer is non-empty");
  for (const needle of mustInclude) {
    assert(answer.toLowerCase().includes(needle.toLowerCase()), `Includes "${needle}"`);
  }
  for (const bad of mustNotInclude) {
    assert(!answer.toLowerCase().includes(bad.toLowerCase()), `Does NOT include generic fallback "${bad}"`);
  }
}

console.log("\n=== Option / dropdown matching ===\n");

for (const scenario of LUMA_OPTION_SCENARIOS) {
  const terms = getMatchTerms(TEST_PROFILE, scenario.label);
  const picked = findBestOption(scenario.options, terms, TEST_PROFILE);
  console.log(`Label: ${scenario.label}`);
  console.log(`  Options: ${scenario.options.join(" | ")}`);
  console.log(`  Picked: ${picked}`);
  assert(picked === scenario.expect, `Picks "${scenario.expect}"`);
}

console.log("\n=== Summary ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}

console.log("\nAll tests passed. Safe to load in Chrome.\n");
