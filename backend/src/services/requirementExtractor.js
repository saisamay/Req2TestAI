
// ─── Gate 2: Broken-word / OCR-artifact detector ────────────────────────────
function hasBrokenWords(text) {
  // Flags strings where a word was split across a chunk boundary,
  // e.g. "ftware Requirements Specificati", "equirement", "uthentication sy"
  // Heuristic: a token of 4+ chars that has no vowel, OR
  // a sentence that starts/ends mid-word (no leading capital / no trailing punct
  // after stripping known suffixes).
  const startsWithLowerFragment = /^[a-z]{2,10}\s/.test(text); // e.g. "tion the system"
  const endsWithFragment = /\s[a-z]{2,6}$/.test(text);        // e.g. "the sys"
  const noVowelToken = /\b[^aeiouAEIOU\s\d\W]{5,}\b/.test(text); // e.g. "Spcfctn"
  return startsWithLowerFragment || endsWithFragment || noVowelToken;
}

// ─── Gate 3: Noise detector ──────────────────────────────────────────────────
const NOISE_PATTERNS = [
  /^(table of contents|list of figures|revision history)/i,
  /\b(student id|team member|project title|course code|submitted (by|to)|instructor|date\s*:)/i,
  /^(introduction|overview|scope|purpose|references|appendix|glossary)\b/i,
  /^\d+(\.\d+)*\s*$/,           // standalone section numbers like "3.2.1"
  /^(figure|table|diagram)\s+\d+/i,
  /^page\s+\d+/i,
  /^[A-Z\s]{4,}$/,              // ALL-CAPS headings e.g. "FUNCTIONAL REQUIREMENTS"
  /^(version|author|status|date)\s*:/i,
  /^\[.*?\]$/,                  // placeholder brackets
];

function isNoise(text) {
  return NOISE_PATTERNS.some((re) => re.test(text.trim()));
}

// ─── Gate 6: Multi-requirement blob splitter ─────────────────────────────────
/**
 * Splits a blob like:
 * "Teachers can update classrooms and students can view availability and admin can monitor usage."
 * into atomic single-actor/single-action sentences.
 *
 * Strategy:
 *  1. Split on coordinating conjunctions that introduce a NEW subject.
 *  2. Recognise subject-change signals: "<noun> can/shall/must/will/should".
 */
function splitBlobs(text) {
  // Pattern: split before "and/or" that is immediately followed by a new subject phrase
  // e.g. "... classrooms and students can ..." → split at "and students"
  const subjectPattern =
    /\s+(?:and|or)\s+(?=[A-Z][a-z]+\s+(?:can|shall|must|will|should|are able to|is able to))/g;

  const parts = text.split(subjectPattern).map((s) => s.trim()).filter(Boolean);

  // If splitting produced only 1 part, try a secondary split on semicolons
  if (parts.length === 1) {
    return text.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return parts;
}

// ─── Gate 7: Classifier ──────────────────────────────────────────────────────
const CLASSIFICATION_RULES = [
  {
    type: "security",
    pattern:
      /\b(security|authenticat|authoriz|encrypt|decrypt|password|login|logout|access control|token|jwt|ssl|tls|role.based|privilege|permission|otp|two.factor|2fa|session expir)\b/i,
  },
  {
    type: "performance",
    pattern:
      /\b(performance|response time|latency|throughput|uptime|sla|load time|process within|within \d+ second|millisecond|concurrent user|transactions? per second|tps|bandwidth)\b/i,
  },
  {
    type: "non-functional",
    pattern:
      /\b(availability|scalability|usability|accessibility|reliability|maintainability|portability|compatibility|fault.toleran|disaster recovery|backup|restore|24\/7|99\.?\d*%)\b/i,
  },
  // functional is the default — no pattern needed
];

function classify(text) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "functional";
}

// ─── Gate 1 + 5 + 8: Sentence integrity validator ────────────────────────────
/**
 * A "complete thought" heuristic:
 *  - Has a subject-verb pair (very loose: contains a verb-like word)
 *  - Ends with punctuation OR is long enough to be self-contained
 *  - Does NOT start with a lowercase fragment (already caught by hasBrokenWords,
 *    but double-checked here for safety)
 */
function hasIntegrity(text) {
  const tooShort = text.length < 40; // raised from 30 to reduce fragments
  const startsWithLower = /^[a-z]/.test(text);
  const hasVerb =
    /\b(can|shall|must|will|should|is|are|was|were|has|have|had|allows?|enables?|provides?|displays?|sends?|receives?|stores?|validates?|generates?|notifies?|supports?|manages?|processes?|authenticates?|logs?)\b/i.test(
      text
    );
  return !tooShort && !startsWithLower && hasVerb;
}

// ─── Main extractor ───────────────────────────────────────────────────────────
function extractRequirements(chunks) {
  const requirements = [];
  let noiseCount = 0;
  let totalCandidates = 0;

  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== "string") return;

    // ── Step 1: Normalise whitespace & ligatures left by PDF parsers
    const normalised = chunk
      .replace(/\r\n/g, "\n")
      .replace(/\t/g, " ")
      .replace(/\f/g, "\n")          // form-feed from PDF pages
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      .replace(/…/g, "...")
      .replace(/ {2,}/g, " ");

    // ── Step 2: Split into candidate sentences
    // Use sentence boundaries (. ! ?) AND bullet/list markers
    const rawParts = normalised.split(
      /(?<=[.!?])\s+|[\n]+|(?:^|\s)[•◦▪▸\-–—]\s*/gm
    );

    rawParts.forEach((raw) => {
      const text = raw.trim();
      totalCandidates++;

      // Gate 2: skip broken OCR artifacts
      if (hasBrokenWords(text)) return;

      // Gate 3: skip noise
      if (isNoise(text)) {
        noiseCount++;
        return;
      }

      // Gate 1 + 8: skip incomplete thoughts / fragments
      if (!hasIntegrity(text)) return;

      // Gate 6: split multi-requirement blobs
      const atomic = splitBlobs(text);

      atomic.forEach((req) => {
        const trimmed = req.trim();

        // Re-check integrity on each atomic part after splitting
        if (!hasIntegrity(trimmed)) return;
        if (isNoise(trimmed)) { noiseCount++; return; }

        // Gate 7: classify
        const type = classify(trimmed);

        requirements.push({
          text: trimmed,
          type,
        });
      });
    });
  });

  // ─── Gate 3: Noise ratio guard ──────────────────────────────────────────────
  const noiseRatio = totalCandidates > 0 ? noiseCount / totalCandidates : 0;
  if (noiseRatio > 0.10) {
    console.warn(
      `[extractRequirements] ⚠️  Noise ratio ${(noiseRatio * 100).toFixed(1)}% exceeds 10% threshold. ` +
        `Fix upstream preprocessing before passing to AI model.`
    );
  }

  // ─── Gate 4: Count sanity guard ─────────────────────────────────────────────
  const count = requirements.length;
  if (count < 40) {
    console.warn(
      `[extractRequirements] ⚠️  Only ${count} requirements extracted — possible under-extraction. ` +
        `Check chunk boundaries or PDF parsing quality.`
    );
  } else if (count > 100) {
    console.warn(
      `[extractRequirements] ⚠️  ${count} requirements extracted — possible fragmentation. ` +
        `Consider merging very short sentences or raising the integrity threshold.`
    );
  } else {
    console.log(`[extractRequirements] ✅ ${count} requirements extracted (within 40–100 range).`);
  }

  return requirements;
}

// ─── Optional: self-test (run with `node requirementExtractor.js`) ────────────
if (require.main === module) {
  const sampleChunks = [
    // Gate 1 pass — complete thought
    "The system shall send email notifications to students when their class is rescheduled.",
    // Gate 2 fail — broken word
    "ftware Requirements Specificati on the system must",
    // Gate 3 fail — noise heading
    "FUNCTIONAL REQUIREMENTS",
    // Gate 6 fail — blob
    "Teachers can update classrooms and Students can view availability and Admin can monitor usage.",
    // Gate 7 check — security
    "All API endpoints must enforce JWT-based authentication before returning data.",
    // Gate 5 check — can a test case be written? Yes.
    "The system must display an error message within 2 seconds when a login attempt fails.",
  ];

  const result = extractRequirements(sampleChunks);
  console.log("\nExtracted requirements:");
  result.forEach((r, i) => console.log(`  ${i + 1}. [${r.type}] ${r.text}`));
}

module.exports = { extractRequirements };