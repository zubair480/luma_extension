import { buildBackgroundAnswer } from "./profile.js";

function eventName(eventContext) {
  const title = eventContext?.title || "";
  if (!title || title.toLowerCase().includes("luma")) return "this event";
  return title.length > 80 ? "this event" : title;
}

function mentionsVideo(text = "") {
  return /video|gen(?:erative)? ai|diffusion|multimodal|runway|pika|sora/i.test(text);
}

function mentionsAi(text = "") {
  return /ai|llm|gpt|machine learning|ml|agent|gen ai|generative/i.test(text);
}

function profileWorksWithVideo(profile) {
  const blob = `${profile.title} ${profile.company} ${profile.bio}`.toLowerCase();
  return mentionsVideo(blob);
}

function profileWorksWithAi(profile) {
  const blob = `${profile.title} ${profile.company} ${profile.bio} ${profile.techStack}`.toLowerCase();
  return mentionsAi(blob);
}

function contextualFallback(lower, profile, evt) {
  const title = profile.title?.trim() || "Software Engineer";
  const company = profile.company?.trim();
  const companyPart = company ? ` at ${company}` : "";

  if (
    lower.includes("team") ||
    lower.includes("headcount") ||
    lower.includes("how many people") ||
    lower.includes("how big") ||
    lower.includes("size of your") ||
    lower.includes("employees")
  ) {
    return (
      profile.teamSize ||
      "Small team — roughly 5–10 people on the engineering side, with support handled by a lean ops group."
    );
  }

  if (
    lower.includes("tech stack") ||
    lower.includes("support platform") ||
    lower.includes("what tools") ||
    lower.includes("which tools") ||
    lower.includes("what platform") ||
    lower.includes("infrastructure") ||
    lower.includes("software do you use")
  ) {
    return (
      profile.techStack ||
      "TypeScript, Python, React, Node.js, PostgreSQL, and AWS — plus standard ticketing/chat tools for support workflows."
    );
  }

  if (lower.includes("support") && (lower.includes("process") || lower.includes("workflow"))) {
    return "We use a lightweight ticket + async chat workflow with clear SLAs and escalation paths for urgent issues.";
  }

  if (lower.includes("role") || lower.includes("responsibilit")) {
    return `As a ${title}${companyPart}, I focus on building reliable software and collaborating across teams.`;
  }

  if (lower.includes("experience") || lower.includes("years")) {
    return profile.bio?.trim() || `Several years of hands-on experience as a ${title}${companyPart}.`;
  }

  if (lower.includes("goal") || lower.includes("objective") || lower.includes("hoping to get")) {
    return `Learn from peers, share practical lessons from my work as a ${title}, and connect with the community at ${evt}.`;
  }

  if (mentionsAi(lower) || mentionsAi(eventContext?.description)) {
    return profileWorksWithAi(profile)
      ? `I use AI/LLM tools in my day-to-day work as a ${title} — building features, automating workflows, and experimenting with new models.`
      : `I'm exploring AI and LLM tooling and interested in practical applications for ${title}s.`;
  }

  return `Relevant to my work as a ${title}${companyPart} — happy to discuss further at ${evt}.`;
}

export function pickAnswerForQuestion(question, profile, eventContext = {}) {
  const lower = String(question || "").toLowerCase();
  const evt = eventName(eventContext);
  const title = profile.title?.trim() || "Software Engineer";
  const company = profile.company?.trim();

  if (
    lower.includes("any question") ||
    (lower.includes("do you have") && lower.includes("question")) ||
    lower.includes("questions for") ||
    lower.includes("related questions")
  ) {
    return profile.noQuestionsAnswer || "No questions at this time — looking forward to the event!";
  }

  if (
    lower.includes("how did you hear") ||
    lower.includes("how did you find") ||
    lower.includes("mailing list") ||
    lower.includes("wechat") ||
    lower.includes("which friend") ||
    lower.includes("referral")
  ) {
    return profile.referralSource || "Found it while browsing events on Luma.";
  }

  if (
    lower.includes("background") ||
    lower.includes("tell us a little about") ||
    lower.includes("about yourself") ||
    lower.includes("professional experience")
  ) {
    return buildBackgroundAnswer(profile);
  }

  if (lower.includes("linkedin")) return profile.linkedin || buildBackgroundAnswer(profile);
  if (lower.includes("github")) {
    return profile.github || profile.website || "github.com/zubairzafar";
  }
  if (lower.includes("twitter") || lower.includes(" x ") || lower.endsWith(" x?")) {
    return profile.twitter || "I mostly share updates on LinkedIn.";
  }
  if (lower.includes("website")) return profile.website || "";
  if (lower.includes("job title") || (lower.includes("title") && !lower.includes("entitle"))) {
    return profile.title || title;
  }
  if (
    (lower.includes("company") || lower.includes("organization")) &&
    !lower.includes("tech stack") &&
    !lower.includes("platform")
  ) {
    return profile.company || company || "";
  }

  if (
    lower.includes("team") ||
    lower.includes("headcount") ||
    lower.includes("how many people") ||
    lower.includes("how big") ||
    lower.includes("employees") ||
    (lower.includes("size") && lower.includes("support"))
  ) {
    return (
      profile.teamSize ||
      "Small team — roughly 5–10 people on the engineering side, with support handled by a lean ops group."
    );
  }

  if (
    lower.includes("tech stack") ||
    lower.includes("support platform") ||
    lower.includes("what tools") ||
    lower.includes("which tools") ||
    lower.includes("what platform") ||
    (lower.includes("stack") && lower.includes("current"))
  ) {
    return (
      profile.techStack ||
      "TypeScript, Python, React, Node.js, PostgreSQL, and AWS — plus standard ticketing/chat tools for support workflows."
    );
  }

  if (
    lower.includes("hoping to get") ||
    lower.includes("what do you want to get") ||
    lower.includes("what would you like to get")
  ) {
    return `Practical takeaways, honest conversations with builders, and new connections in the ${evt} community.`;
  }

  if (
    (lower.includes("building with") || lower.includes("working with")) &&
    (mentionsAi(lower) || lower.includes("llm"))
  ) {
    return profileWorksWithAi(profile)
      ? "Yes — I build with LLMs and AI tooling regularly in my engineering work."
      : "I'm actively exploring LLM and AI workflows and looking to apply them more in production.";
  }

  if (lower.includes("experience with ai") || lower.includes("experience with llm") || lower.includes("ai experience")) {
    return profileWorksWithAi(profile)
      ? `Hands-on experience integrating AI into products as a ${title} — prototyping, shipping features, and evaluating models.`
      : `Growing experience with AI tools as a ${title}; eager to learn production patterns at ${evt}.`;
  }

  if (lower.includes("startup stage") || lower.includes("company stage")) {
    return profile.companyStage || "Early-stage / growth — small eng team shipping quickly.";
  }

  if (lower.includes("industry") || lower.includes("sector")) {
    return profile.industry || "Technology / Software";
  }

  if (lower.includes("dietary") || lower.includes("food allergy") || lower.includes("meal preference")) {
    return profile.dietary || "No dietary restrictions.";
  }

  if (
    lower.includes("biggest challenge") ||
    lower.includes("main challenge") ||
    lower.includes("hardest part") ||
    (lower.includes("challenge") && lower.includes("working with"))
  ) {
    if (mentionsVideo(lower) || mentionsVideo(eventContext.description)) {
      return "Temporal consistency, controllability, and reliable quality across longer clips are still the biggest challenges with video models — especially for real production workflows.";
    }
    if (mentionsAi(lower) || mentionsAi(eventContext.description)) {
      return "Reliability, cost, and evals at scale — making LLM features dependable in production without slowing the team down.";
    }
    return `The biggest challenge in my work is staying on top of a fast-moving space while shipping reliable solutions — balancing experimentation with practical constraints as a ${title}.`;
  }

  if (
    lower.includes("excited to learn") ||
    lower.includes("hope to learn") ||
    lower.includes("what do you want to learn") ||
    lower.includes("looking forward to learning") ||
    lower.includes("most excited")
  ) {
    if (mentionsVideo(lower) || mentionsVideo(eventContext.description)) {
      return `I'm most excited to learn practical workflows, production tips, and what's actually working today with video generation — plus meet others building in the space at ${evt}.`;
    }
    if (mentionsAi(lower) || mentionsAi(eventContext.description)) {
      return `I'm most excited to learn what's working in production with AI/LLMs, swap implementation lessons, and meet other builders at ${evt}.`;
    }
    return `I'm most excited to learn from practitioners, swap real-world lessons, and connect with people working on similar problems at ${evt}.`;
  }

  if (
    lower.includes("are you currently") ||
    lower.includes("do you currently") ||
    lower.includes("have you worked") ||
    lower.includes("have you used")
  ) {
    if (mentionsVideo(lower)) {
      return profileWorksWithVideo(profile)
        ? "Yes — I work with video generation models in my current role and I'm actively experimenting with them."
        : "I'm exploring video generation models and looking to use them more hands-on in upcoming projects.";
    }
    if (mentionsAi(lower)) {
      return profileWorksWithAi(profile)
        ? "Yes — I use AI/LLM tools regularly in my current role."
        : "I'm exploring AI tooling and looking to use it more hands-on in upcoming projects.";
    }
    return profile.bio?.trim()
      ? `Yes — ${buildBackgroundAnswer(profile)}`
      : `Yes — I'm actively working in this area as a ${title}.`;
  }

  if (lower.includes("why do you want") || lower.includes("why are you interested") || lower.includes("why attend")) {
    return (
      profile.whyAttend ||
      `I'm interested in ${evt} to learn from the community and meet people working on similar problems.`
    );
  }

  if (lower.includes("what are you working on") || lower.includes("current project")) {
    return (
      profile.bio?.trim() ||
      `I'm a ${title}${company ? ` at ${company}` : ""}, focused on building practical tools and learning from the community.`
    );
  }

  if (lower.includes("motivation") || lower.includes("reason for applying")) {
    return profile.whyAttend || `I want to learn, meet peers, and contribute to the conversation around ${evt}.`;
  }

  if (lower.startsWith("are you ") || lower.startsWith("do you ") || lower.startsWith("have you ")) {
    return "Yes.";
  }

  if (lower.includes("how many")) {
    return profile.teamSize || "Roughly 5–10 people, depending on how you count eng vs. support.";
  }

  if (lower.includes("challenge")) {
    return mentionsVideo(lower)
      ? "Getting consistent, controllable output from video models at scale is still the hardest part."
      : `Balancing speed, quality, and practicality in my day-to-day work as a ${title}.`;
  }

  if (lower.includes("excited") || lower.includes("looking forward")) {
    return `I'm looking forward to learning from speakers and attendees at ${evt} and connecting with the community.`;
  }

  return contextualFallback(lower, profile, evt);
}

export function smartPlaceholderAnswers(questions, profile, eventContext) {
  return questions.map((q) => pickAnswerForQuestion(q, profile, eventContext));
}
