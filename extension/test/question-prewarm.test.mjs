/**
 * Which registration questions get pre-answered by the model ahead of the form.
 * Run: npm run test:prewarm
 */
import { isModelQuestion, pickPrewarmQuestions } from "../lib/question-prewarm.js";

let passed = 0;
let failed = 0;
function assert(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

// Real question sets from live Luma events.
const coreweave = [
  { label: "Please link to a project you've built for a hackathon or otherwise! We love to see what people have made :)", required: true, question_type: "url" },
  { label: "What's your GitHub?", required: true, question_type: "url" },
  { label: "What institution (company / startup / school) are you with?", required: true, question_type: "text" },
  { label: "Any other profile links you'd like to share? (e.g. X.com, LinkedIn))", required: false, question_type: "text" },
  { label: "Which best describes you?", required: true, question_type: "multi-select", options: ["Founder", "Engineer"] },
  { label: "Ideas for what you'd like to build? (we won't hold you to it)", required: true, question_type: "long-text" },
  { label: "Are you with a team? If so, please list their names/Luma emails", required: true, question_type: "long-text" },
  { label: "Terms and Conditions", required: true, question_type: "terms" },
];
const infra = [
  { label: "What is your LinkedIn profile?", required: true, question_type: "linkedin" },
  { label: "What is your company website?", required: true, question_type: "company" },
  { label: "Which best describes you?", required: true, question_type: "multi-select", options: ["a", "b"] },
  { label: "In one or two sentences, what are you building, researching, or focused on right now?", required: true, question_type: "text" },
  { label: "Who else in your network should we invite? Please share the email / LinkedIn with us.", required: false, question_type: "text" },
];
const meetup = [
  { label: "What Claude Code features or capabilities are you most interested in discussing at this meetup?", required: true, question_type: "text" },
  { label: "What brings you to this event?", required: false, question_type: "text" },
  { label: "How did you find out about this event?", required: false, question_type: "text" },
  { label: "Where do you work or study?", required: true, question_type: "text" },
  { label: "Number of employees at your company?", required: true, question_type: "dropdown", options: ["1-10"] },
];

console.log("\nCoreWeave hackathon form");
const cw = pickPrewarmQuestions(coreweave).map((q) => q.label);
assert("build ideas is a model question", cw.some((l) => l.startsWith("Ideas for what")));
assert("team names/emails (about others) is a model question", cw.some((l) => l.startsWith("Are you with a team")));
assert("institution / company is not", !cw.some((l) => l.startsWith("What institution")));
assert("profile links are not", !cw.some((l) => l.startsWith("Any other profile")));
assert("url / multi-select / terms are not", cw.length === 2);

console.log("\nAI Infra form");
const inf = pickPrewarmQuestions(infra).map((q) => q.label);
assert("what are you building is a model question", inf.some((l) => l.startsWith("In one or two")));
assert("who else to invite (about others) is a model question", inf.some((l) => l.startsWith("Who else")));
assert("linkedin / company / multi-select are not", inf.length === 2);

console.log("\nClaude Code meetup form");
const mt = pickPrewarmQuestions(meetup).map((q) => q.label);
assert("features to discuss is a model question", mt.some((l) => l.startsWith("What Claude Code")));
assert("what brings you is a model question", mt.includes("What brings you to this event?"));
assert("how did you find out is not (answered 'Luma')", !mt.includes("How did you find out about this event?"));
assert("where do you work is not (company)", !mt.includes("Where do you work or study?"));
assert("dropdown is not", mt.length === 2);

console.log("\nOrdering and cap");
const many = Array.from({ length: 7 }, (_, i) => ({ label: `Free text question ${i}?`, required: i % 2 === 1, question_type: "text" }));
const capped = pickPrewarmQuestions(many, 4);
assert("capped at four", capped.length === 4);
assert("required questions come first", capped.slice(0, 3).every((q) => q.required));
assert("type is normalised", isModelQuestion({ label: "Tell us something", question_type: "LONG-TEXT" }));
assert("empty label is never a model question", !isModelQuestion({ label: "", question_type: "text" }));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
