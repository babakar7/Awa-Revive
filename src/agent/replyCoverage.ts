/**
 * Deterministic coverage guard for information-heavy client messages.
 *
 * First-contact presentation is repairable: omitting it must never erase an
 * otherwise useful business answer. Business facts and unsafe content remain
 * blocking requirements.
 */

export type ReplyRequirement =
  | "first_contact_greeting"
  | "automated_identity"
  | "booking_method"
  | "schedule_overview"
  | "location"
  | "no_unsolicited_question";

export interface ReplyCoverageEvidence {
  /** The current message is the caption of the weekly schedule image. */
  scheduleAttached?: boolean;
}

export type IntroRepairLanguage = "fr" | "en" | "wo";

export interface IntroRepairResult {
  text: string;
  /** One message normally; split only to preserve content at a channel limit. */
  segments: string[];
  repaired: boolean;
  added: Array<"first_contact_greeting" | "automated_identity">;
  language: IntroRepairLanguage;
}

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asksHowToBook(text: string): boolean {
  return (
    /\b(?:comment|how)\b.{0,45}\b(?:reserv|book)/.test(text) ||
    /\b(?:reservation|booking)\b.{0,25}\b(?:comment|how)\b/.test(text) ||
    /\b(?:nan la|naka la)\b.{0,35}\b(?:reserv|book)/.test(text)
  );
}

function asksForLocation(text: string): boolean {
  return (
    /\b(?:adresse|address|localisation|location)\b/.test(text) ||
    /\b(?:vous etes|tu es|c est|vous vous trouvez) ou\b/.test(text) ||
    /\bou (?:etes vous|est (?:revive|le studio)|se trouve (?:revive|le studio))\b/.test(text) ||
    /\b(?:revive|le studio)\b.{0,25}\b(?:se trouve|est situe)\b.{0,10}\bou\b/.test(text) ||
    /\bwhere (?:are you|is (?:revive|the studio)|are you located)\b/.test(text) ||
    /\bfan (?:la|ngeen|nga)\b.{0,20}\bnekk\b/.test(text)
  );
}

function asksForOverallSchedule(text: string): boolean {
  return (
    /\b(?:horaires?|planning|schedule|timetable)\b/.test(text) ||
    /\bprogramme\b.{0,30}\b(?:semaine|cours|studio|today|week)\b/.test(text) ||
    /\b(?:semaine|cours|studio|today|week)\b.{0,30}\bprogramme\b/.test(text) ||
    /\b(?:tous?|all)\b.{0,30}\b(?:creneaux|slots|classes|cours)\b/.test(text)
  );
}

function hasBuyingSignal(text: string): boolean {
  return (
    /\b(?:je veux|je voudrais|j aimerais|je souhaite|on veut|nous voulons)\b.{0,25}\b(?:reserv|book)/.test(text) ||
    /\b(?:pouvez[- ]vous|peux[- ]tu|can you)\b.{0,30}\b(?:reserv|book)/.test(text) ||
    /\b(?:reserve|reservez|book)\b.{0,12}\b(?:moi|nous|me|us)\b/.test(text) ||
    /\b(?:je prends|je choisis)\b/.test(text)
  );
}

export function deriveReplyRequirements(
  inboundText: string,
  firstContact: boolean,
): ReplyRequirement[] {
  const text = normalized(inboundText);
  const requirements: ReplyRequirement[] = [];

  if (firstContact) {
    requirements.push("first_contact_greeting", "automated_identity");
  }
  if (asksHowToBook(text)) requirements.push("booking_method");
  if (asksForOverallSchedule(text)) requirements.push("schedule_overview");
  if (asksForLocation(text)) requirements.push("location");

  const hasInformationRequest = requirements.some((requirement) =>
    ["booking_method", "schedule_overview", "location"].includes(requirement),
  );
  if (hasInformationRequest && !hasBuyingSignal(text)) {
    requirements.push("no_unsolicited_question");
  }
  return requirements;
}

const GREETING_RE =
  /\b(?:bonjour|bonsoir|salut|coucou|hello|hi|hey|good\s+(?:morning|afternoon|evening)|salam(?:aale[yi]kum)?|salaam(?:\s+maalekum)?|asalaam(?:u\s+maalekum)?|nanga\s+def)\b/i;

function hasGreeting(reply: string): boolean {
  return GREETING_RE.test(normalized(reply));
}

function hasAutomatedIdentity(reply: string): boolean {
  const text = normalized(reply);
  const automated =
    /\bassistante? automatisee?\b/.test(text) ||
    /\bautomated assistant\b/.test(text) ||
    /\bassistant(?:e)? (?:bu|buy) automat/.test(text);
  return automated && /\bawa\b/.test(text);
}

function satisfies(requirement: ReplyRequirement, reply: string, evidence: ReplyCoverageEvidence): boolean {
  const text = normalized(reply);
  const lower = reply.toLowerCase();
  switch (requirement) {
    case "first_contact_greeting":
      return hasGreeting(reply);
    case "automated_identity":
      return hasAutomatedIdentity(reply);
    case "booking_method":
      return (
        /\b(?:reserv|book)/.test(text) &&
        (/\b(?:ici|whatsapp|site|online|en ligne|avec moi|through me)\b/.test(text) ||
          /(?:www\.)?revive\.sn/.test(lower))
      );
    case "schedule_overview": {
      const hasPlanningLink = /(?:www\.)?revive\.sn\/planning/.test(lower);
      const relaysTextSchedule = /\b(?:lundi|monday)\b/.test(text) && /\b(?:dimanche|sunday)\b/.test(text);
      return hasPlanningLink && (evidence.scheduleAttached === true || relaysTextSchedule);
    }
    case "location":
      return /\balmadies\b/.test(text) && /maps\.app\.goo\.gl\//.test(lower);
    case "no_unsolicited_question":
      return (
        !reply.includes("?") &&
        !/\b(?:quel cours|quelle activite|voulez vous|souhaitez vous|tu veux|which class|would you like)\b/.test(text)
      );
  }
}

export function missingReplyRequirements(
  reply: string,
  requirements: readonly ReplyRequirement[],
  evidence: ReplyCoverageEvidence = {},
): ReplyRequirement[] {
  return requirements.filter((requirement) => !satisfies(requirement, reply, evidence));
}

function repairLanguage(language: string | null | undefined): IntroRepairLanguage {
  return language === "en" || language === "wo" ? language : "fr";
}

function fixedIntro(language: IntroRepairLanguage, formal: boolean): { greeting: string; identity: string } {
  if (language === "en") {
    return { greeting: "Hi!", identity: "I’m Awa, Revive’s automated assistant 😊" };
  }
  if (language === "wo") {
    return { greeting: "Nanga def!", identity: "Man Awa laa, Revive assistant bu otomaatig laa 😊" };
  }
  return {
    greeting: formal ? "Bonjour !" : "Salut !",
    identity: "Moi c'est Awa, je suis une assistante automatisée de Revive 😊",
  };
}

function greetingEnd(text: string): number {
  const match = GREETING_RE.exec(text);
  if (!match || match.index === undefined) return 0;
  const tail = text.slice(match.index + match[0].length).match(/^\s*[!,.…?]+/u)?.[0] ?? "";
  const punctuationEnd = match.index + match[0].length + tail.length;
  const spacing = text.slice(punctuationEnd).match(/^\s*/u)?.[0] ?? "";
  return punctuationEnd + spacing.length;
}

/** Repair presentation only, retaining the complete model-authored answer. */
export function repairFirstContactIntro(
  reply: string,
  requirements: readonly ReplyRequirement[],
  options: { language?: string | null; formal?: boolean; maxLength?: number } = {},
): IntroRepairResult {
  const original = reply.trim();
  const language = repairLanguage(options.language);
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const needsGreeting = requirements.includes("first_contact_greeting") && !hasGreeting(original);
  const needsIdentity = requirements.includes("automated_identity") && !hasAutomatedIdentity(original);
  const added: IntroRepairResult["added"] = [];
  if (needsGreeting) added.push("first_contact_greeting");
  if (needsIdentity) added.push("automated_identity");
  if (added.length === 0) {
    return { text: original, segments: [original], repaired: false, added, language };
  }

  const intro = fixedIntro(language, options.formal === true);
  let insertionAt = 0;
  let inserted: string;
  if (needsGreeting && needsIdentity) {
    inserted = `${intro.greeting} ${intro.identity}\n\n`;
  } else if (needsGreeting) {
    inserted = `${intro.greeting}\n\n`;
  } else {
    insertionAt = greetingEnd(original);
    inserted = `${insertionAt > 0 && !/\s$/u.test(original.slice(0, insertionAt)) ? " " : ""}${intro.identity}`;
    if (original.slice(insertionAt).trim()) inserted += "\n\n";
  }

  const text = original.slice(0, insertionAt) + inserted + original.slice(insertionAt);
  if (text.length <= maxLength || original.length > maxLength) {
    return { text, segments: [text], repaired: true, added, language };
  }
  const before = original.slice(0, insertionAt);
  const after = original.slice(insertionAt);
  const segments = [`${before}${inserted}`.trimEnd(), after].filter((segment) => segment.length > 0);
  return { text, segments, repaired: true, added, language };
}

export function logOutboundIntroRepair(args: {
  clientId: string;
  channel: "text" | "present_options" | "schedule_caption";
  repair: IntroRepairResult;
}): void {
  if (!args.repair.repaired) return;
  console.info(
    `[outbound_intro_repaired] client=${args.clientId} channel=${args.channel} ` +
      `language=${args.repair.language} added=${args.repair.added.join(",")}`,
  );
}

const REQUIREMENT_INSTRUCTIONS: Record<ReplyRequirement, string> = {
  first_contact_greeting: "Open with a warm greeting that mirrors the client's language/register.",
  automated_identity: 'Introduce Awa explicitly as Revive\'s automated assistant (French exact words: "je suis une assistante automatisée").',
  booking_method: "Explain that the client can reserve directly here with Awa or on www.revive.sn.",
  schedule_overview: "Use get_class_schedule and include www.revive.sn/planning in its message/caption.",
  location: "Answer with Revive, Almadies, Dakar and the exact Google Maps link from BUSINESS INFO.",
  no_unsolicited_question: "This is an informational request, not a buying signal: answer fully and end without a booking question or other CTA.",
};

export function replyRequirementsInstruction(requirements: readonly ReplyRequirement[]): string {
  if (requirements.length === 0) return "";
  return (
    "\n\nCURRENT-TURN REQUIRED COVERAGE — server-enforced before WhatsApp delivery:\n" +
    requirements.map((requirement) => `- ${REQUIREMENT_INSTRUCTIONS[requirement]}`).join("\n") +
    "\nFirst-contact greeting and automated identity are repaired deterministically if omitted. " +
    "If you use present_options, its body must satisfy these requirements. If you use get_class_schedule, pass the complete client-facing answer in its message field; the image caption is the whole reply, so output <NO_REPLY> after it succeeds."
  );
}

export function correctiveCoverageInstruction(missing: readonly ReplyRequirement[]): string {
  return (
    "Your previous draft was blocked because it did not fully answer the client's current message. " +
    "Rewrite one concise WhatsApp reply and satisfy every missing business requirement below. Do not mention this validation.\n" +
    missing.map((requirement) => `- ${REQUIREMENT_INSTRUCTIONS[requirement]}`).join("\n")
  );
}

export function missingRequirementsToolResult(missing: readonly ReplyRequirement[]): string {
  return JSON.stringify({
    error: "reply_requirements_missing",
    missing,
    message:
      "Nothing was sent. Rewrite the complete client-facing message so it satisfies every CURRENT-TURN REQUIRED COVERAGE item, then retry this tool.",
  });
}
