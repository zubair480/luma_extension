export const DEFAULT_PROFILE = {
  name: "",
  email: "",
  workEmail: "",
  linkedin: "",
  company: "",
  title: "",
  phone: "",
  website: "",
  bio: "",
  teamSize: "",
  techStack: "",
  github: "",
  whyAttend: "I'm interested in connecting with the local community and learning from others in the space.",
  noQuestionsAnswer: "No questions at this time — looking forward to the event!",
  referralSource: "Found it while browsing events on Luma.",
  customFields: {},
};

export function normalizeProfile(raw = {}) {
  return { ...DEFAULT_PROFILE, ...raw, customFields: raw.customFields || {} };
}

export function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || "",
    last: parts.slice(1).join(" "),
  };
}

export function buildBackgroundAnswer(profile) {
  if (profile.bio?.trim()) return profile.bio.trim();

  const title = profile.title?.trim() || "Software Engineer";
  const parts = [`I'm a ${title}`];
  if (profile.company?.trim()) parts.push(`at ${profile.company.trim()}`);
  parts.push("excited to connect and build with others in the space.");
  return `${parts.join(" ")}`;
}

export function profileFieldHints() {
  return [
    { key: "name", label: "Full name", type: "text", required: true },
    { key: "email", label: "Personal email", type: "email", required: true },
    { key: "workEmail", label: "Work email", type: "email" },
    { key: "linkedin", label: "LinkedIn URL", type: "url" },
    { key: "company", label: "Company", type: "text" },
    { key: "title", label: "Job title (e.g. Software Engineer)", type: "text" },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "website", label: "Website", type: "url" },
    { key: "bio", label: "Short bio / background paragraph", type: "textarea" },
    { key: "teamSize", label: 'Answer for "How big is your team?" type questions', type: "text" },
    { key: "techStack", label: 'Answer for "Tech stack / support platform" questions', type: "text" },
    { key: "github", label: "GitHub URL or username", type: "text" },
    { key: "whyAttend", label: "Fallback for why-attend / motivation questions only", type: "textarea" },
    { key: "noQuestionsAnswer", label: 'Answer for "Do you have any questions?" fields', type: "text" },
    { key: "referralSource", label: 'Answer for "How did you find this event?" fields', type: "text" },
  ];
}
