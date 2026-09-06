/**
 * Unit tests for constrained option selection (the "select from options" fix).
 * Run: node test/option-select.test.mjs
 */
import { parseOptionChoice } from "../lib/prompt-utils.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
    failures.push(name);
  }
}

/** Load the non-module form-intelligence.js in a DOM sandbox (same trick as full-audit). */
function loadFormIntelligence() {
  const src = fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8");
  const document = {
    body: { innerText: "" },
    querySelector: () => null,
    querySelectorAll: () => [],
    title: "",
  };
  const fn = new Function(
    "document",
    "window",
    src +
      "\nreturn { pickConfidentOption, pickBestSelectOption, selectionPrefsFor, classifyQuestion, answerForQuestion, selectEventPersona, applyEventPersona };"
  );
  return fn(document, {});
}

const opts = (arr) => arr.map((text) => ({ text }));

console.log("=== Option selection tests ===\n");

console.log("parseOptionChoice");
const OPTIONS = ["Engineer", "Founder", "Investor", "Student", "Other"];
assert("Parses a bare number", parseOptionChoice("2", OPTIONS) === "Founder");
assert("Parses number in a sentence", parseOptionChoice("The best option is 1.", OPTIONS) === "Engineer");
assert("Out-of-range number falls through to null", parseOptionChoice("99", ["Yes", "No"]) === null);
assert("Exact text (case-insensitive)", parseOptionChoice("investor", OPTIONS) === "Investor");
assert("Contained text match", parseOptionChoice("I'd say Student here", OPTIONS) === "Student");
assert("Gibberish returns null", parseOptionChoice("asdf", OPTIONS) === null);
assert("Empty reply returns null", parseOptionChoice("", OPTIONS) === null);
assert("Null options returns null", parseOptionChoice("1", null) === null);
assert(
  "Number takes priority over stray text",
  parseOptionChoice("3 (Investor)", OPTIONS) === "Investor"
);

console.log("\npickConfidentOption / pickBestSelectOption");
const fi = loadFormIntelligence();
const profile = { job_title: "Software Engineer", company: "Acme" };

// Confident match: gender question → male-ish option.
assert(
  "Confident: gender picks a male option",
  fi.pickConfidentOption(opts(["Female", "Male", "Non-binary"]), "Gender", profile)?.text === "Male"
);

// No keyword match at all → confident returns null (so the LLM is consulted instead of guessing).
const weird = opts(["Purple", "Triangle", "Thursday"]);
assert(
  "No confident match returns null (no blind guess)",
  fi.pickConfidentOption(weird, "Pick your spirit animal", profile) === null
);

// pickBestSelectOption still returns a value (first) so required fields are never left empty.
assert(
  "pickBestSelectOption falls back to first option",
  fi.pickBestSelectOption(weird, "Pick your spirit animal", profile)?.text === "Purple"
);

// Placeholder options are ignored.
assert(
  "Placeholder is skipped",
  fi.pickBestSelectOption(opts(["Select an option", "Engineer"]), "Role", profile)?.text === "Engineer"
);

// Referral question confidently matches a known channel.
assert(
  "Referral picks a known channel",
  ["LinkedIn", "Twitter", "Instagram"].includes(
    fi.pickConfidentOption(opts(["Newspaper", "LinkedIn", "Radio"]), "How did you hear about the event?", profile)?.text
  )
);

console.log("\nwork email");
const emailProfile = { email: "me@gmail.com", work_email: "me@eiu.edu" };
assert("Classifies 'Work Email' as work_email", fi.classifyQuestion("Work Email") === "work_email");
assert("Classifies 'Company email address' as work_email", fi.classifyQuestion("Company email address *") === "work_email");
assert("Classifies 'School/University Email' as work_email", fi.classifyQuestion("University Email") === "work_email");
assert("Classifies 'Professional Email' as work_email", fi.classifyQuestion("Professional Email") === "work_email");
assert("Classifies 'Email (business)' as work_email", fi.classifyQuestion("Email (business)") === "work_email");
assert("Plain 'Email' still classifies as email", fi.classifyQuestion("Email") === "email");
assert("Work email answer uses work_email", fi.answerForQuestion("Work Email", emailProfile) === "me@eiu.edu");
assert("Plain email answer uses personal email", fi.answerForQuestion("Email", emailProfile) === "me@gmail.com");
assert(
  "Work email falls back to personal when unset",
  fi.answerForQuestion("Work Email", { email: "me@gmail.com" }) === "me@gmail.com"
);

console.log("\nevent persona");
const personaProfile = {
  job_title: "Software Engineer",
  company: "Eastern Illinois University",
  default_persona: "engineer",
  personas: {
    founder: { job_title: "Founder", company: "Stealth Startup" },
    engineer: { job_title: "Software Engineer", company: "Eastern Illinois University" },
  },
};
assert(
  "Startup event selects founder persona",
  fi.selectEventPersona(personaProfile, "AI Founders & Investors Night", "") === "founder"
);
assert(
  "Engineering event selects engineer persona",
  fi.selectEventPersona(personaProfile, "LLM Engineering Meetup", "") === "engineer"
);
const founderProfile = fi.applyEventPersona(personaProfile, "Startup Demo Day", "Venture capital");
assert("Founder persona uses Founder title", founderProfile.job_title === "Founder");
assert("Founder persona uses Stealth Startup", founderProfile.company === "Stealth Startup");
const engineerProfile = fi.applyEventPersona(personaProfile, "AI Agent Builders", "Software developer meetup");
assert("Default engineer persona uses Software Engineer", engineerProfile.job_title === "Software Engineer");
assert("Engineer persona uses Eastern Illinois University", engineerProfile.company === "Eastern Illinois University");

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed > 0 ? 1 : 0);
