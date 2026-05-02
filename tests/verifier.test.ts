import test from "node:test";
import assert from "node:assert/strict";
import type { CanonicalPaper } from "../src/runtime/literature-store.js";
import { verifyResearchClaims } from "../src/runtime/verifier.js";

function canonicalPaper(overrides: Partial<CanonicalPaper> & Pick<CanonicalPaper, "id" | "key" | "title" | "citation">): CanonicalPaper {
  return {
    abstract: null,
    year: 2026,
    authors: ["Example Author"],
    venue: "Example Venue",
    discoveredVia: ["openalex"],
    identifiers: {
      doi: null,
      pmid: null,
      pmcid: null,
      arxivId: null
    },
    discoveryRecords: [],
    accessCandidates: [],
    bestAccessUrl: "https://example.org/paper",
    bestAccessProvider: "openalex",
    accessMode: "abstract_available",
    fulltextFormat: "none",
    license: null,
    tdmAllowed: null,
    contentStatus: {
      abstractAvailable: true,
      fulltextAvailable: false,
      fulltextFetched: false,
      fulltextExtracted: false
    },
    screeningHistory: [],
    screeningStage: "abstract",
    screeningDecision: "include",
    screeningRationale: "Included for test.",
    accessErrors: [],
    tags: [],
    runIds: [],
    linkedThemeIds: [],
    linkedClaimIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("verifier records provenance, evidence links, and supported claims from canonical papers", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "Riemann Hypothesis",
      researchQuestion: "Which proof-technique families are most prominent?",
      researchDirection: "Review prior proof-technique families.",
      successCriterion: "Produce a concise technique map."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/rh-survey",
        title: "A survey of proof strategies for the Riemann Hypothesis",
        citation: "Example Author (2024). A survey of proof strategies for the Riemann Hypothesis.",
        abstract: "Survey-style source describing analytic approaches, common obstacles, and recurring proof motifs.",
        year: 2024,
        authors: ["Example Author"],
        venue: "Number Theory Review",
        discoveredVia: ["openalex"],
        identifiers: {
          doi: "10.1000/rh-survey",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/rh-survey.pdf",
        bestAccessProvider: "openalex",
        accessMode: "fulltext_open",
        fulltextFormat: "pdf",
        license: null,
        tdmAllowed: true,
        contentStatus: {
          abstractAvailable: true,
          fulltextAvailable: true,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningHistory: [{
          stage: "title",
          decision: "uncertain",
          rationale: "Retained after title screening for deeper review."
        }, {
          stage: "abstract",
          decision: "include",
          rationale: "Abstract-level screening supported deeper review."
        }, {
          stage: "fulltext",
          decision: "include",
          rationale: "Directly relevant survey."
        }],
        screeningStage: "fulltext",
        screeningDecision: "include",
        screeningRationale: "Directly relevant survey.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "Current proof attempts repeatedly return to analytic techniques around the zeta function.",
        evidence: "The gathered papers emphasize analytic methods and frame them as central to the problem.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "grounded");
  assert.equal(report.counts.sources, 1);
  assert.equal(report.counts.supported, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "supported");
  assert.equal(report.verifiedClaims[0]?.confidence, "high");
  assert.equal(report.verifiedClaims[0]?.provenance.length, 1);
  assert.equal(report.verifiedClaims[0]?.evidenceLinks.length, 1);
});

test("verifier keeps source relevance as diagnostics instead of removing cited support", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "autonomous research agents",
      researchQuestion: "How should autonomous research agents perform literature reviews?",
      researchDirection: "Review retrieval, summarization, and evidence organization.",
      successCriterion: "Produce a scoped literature review."
    },
    papers: [
      canonicalPaper({
        id: "paper-cmip6",
        key: "doi:10.1000/cmip6",
        title: "Overview of CMIP6 experimental design and organization",
        citation: "Climate Author (2016). Overview of CMIP6 experimental design and organization.",
        abstract: "This paper describes climate-model intercomparison experimental design and organization.",
        accessMode: "fulltext_open",
        fulltextFormat: "pdf"
      })
    ],
    claims: [
      {
        claim: "Autonomous research agents can organize literature-review evidence using benchmarked workflows.",
        evidence: "The cited source discusses experimental design and organization.",
        sourceIds: ["paper-cmip6"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.supported, 1);
  assert.equal(report.counts.offTopicSources, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "supported");
  assert.deepEqual(report.verifiedClaims[0]?.citedSourceIds, ["paper-cmip6"]);
});

test("verifier marks claims linked only to blocked papers as unverified", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Find direct evidence."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/nursing-home",
        title: "AI in nursing homes",
        citation: "Example Author (2025). AI in nursing homes.",
        abstract: null,
        year: 2025,
        authors: ["Example Author"],
        venue: "Care Automation Review",
        discoveredVia: ["crossref"],
        identifiers: {
          doi: "10.1000/nursing-home",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/paywalled-paper",
        bestAccessProvider: "crossref",
        accessMode: "fulltext_blocked",
        fulltextFormat: "none",
        license: null,
        tdmAllowed: null,
        contentStatus: {
          abstractAvailable: false,
          fulltextAvailable: false,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningHistory: [{
          stage: "title",
          decision: "uncertain",
          rationale: "Discovered but not readable."
        }],
        screeningStage: "title",
        screeningDecision: "uncertain",
        screeningRationale: "Discovered but not readable.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "AI is already displacing workers in nursing homes.",
        evidence: "A discovered paper exists, but it remained blocked.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.unverified, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unverified");
  assert.match(report.unverifiedClaims[0]?.reason ?? "", /blocked|credentials/i);
});

test("verifier emits explicit unknown when the claim itself states evidence is limited", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI job displacement in nursing homes",
      researchQuestion: "What evidence exists regarding AI job displacement in nursing homes?",
      researchDirection: "Literature review.",
      successCriterion: "Clarify what remains unknown."
    },
    papers: [
      {
        id: "paper-1",
        key: "doi:10.1000/ai-care",
        title: "AI in nursing homes",
        citation: "Example Author (2025). AI in nursing homes.",
        abstract: "The literature remains limited and does not provide direct evidence of workforce displacement.",
        year: 2025,
        authors: ["Example Author"],
        venue: "Care Automation Review",
        discoveredVia: ["openalex"],
        identifiers: {
          doi: "10.1000/ai-care",
          pmid: null,
          pmcid: null,
          arxivId: null
        },
        discoveryRecords: [],
        accessCandidates: [],
        bestAccessUrl: "https://example.org/ai-care",
        bestAccessProvider: "openalex",
        accessMode: "abstract_available",
        fulltextFormat: "none",
        license: null,
        tdmAllowed: null,
        contentStatus: {
          abstractAvailable: true,
          fulltextAvailable: false,
          fulltextFetched: false,
          fulltextExtracted: false
        },
        screeningHistory: [{
          stage: "title",
          decision: "uncertain",
          rationale: "Retained after title screening for deeper review."
        }, {
          stage: "abstract",
          decision: "include",
          rationale: "Abstract-level screening only."
        }],
        screeningStage: "abstract",
        screeningDecision: "include",
        screeningRationale: "Abstract-level screening only.",
        accessErrors: [],
        tags: [],
        runIds: [],
        linkedThemeIds: [],
        linkedClaimIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    claims: [
      {
        claim: "There is no direct evidence yet about AI causing job displacement in nursing homes.",
        evidence: "The available literature remains limited and does not provide direct evidence of displacement.",
        sourceIds: ["paper-1"]
      }
    ]
  });

  assert.equal(report.overallStatus, "mixed");
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.verifiedClaims[0]?.supportStatus, "unknown");
  assert.equal(report.verifiedClaims[0]?.confidence, "unknown");
  assert.ok(report.unknowns.some((entry) => /Unknown: There is no direct evidence yet/i.test(entry)));
});

test("verifier does not contain nursing-home-specific relevance overrides", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "AI adoption in nursing homes",
      researchQuestion: "What evidence exists about AI adoption in nursing homes and its effects on staffing, workforce displacement, and care quality?",
      researchDirection: "Review long-term-care evidence.",
      successCriterion: "Use only nursing-home or long-term-care evidence."
    },
    papers: [
      canonicalPaper({
        id: "paper-broad-nursing-ai",
        key: "doi:10.1000/broad-nursing-ai",
        title: "The integration of AI in nursing: applications and challenges",
        citation: "Example Author (2025). The integration of AI in nursing.",
        abstract: "A broad review of artificial intelligence in nursing education and clinical practice."
      })
    ],
    claims: []
  });

  assert.equal(report.counts.offTopicSources, 0);
  assert.notEqual(report.sourceRelevance[0]?.rationale, "The source does not match the nursing-home or long-term-care scope required by the brief.");
});

test("verifier does not contain zeta-specific relevance overrides", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "rigorous numerical verification of Riemann zeta zeros",
      researchQuestion: "Which rigorous numerical verification methods for Riemann zeta zeros use explicit error bounds?",
      researchDirection: "Review verified computation methods for zeta zeros.",
      successCriterion: "Distinguish rigorous verification from heuristic computation."
    },
    papers: [
      canonicalPaper({
        id: "paper-advection",
        key: "doi:10.1000/advection",
        title: "Rigorous numerical computations for 1D advection equations",
        citation: "Example Author (2024). Rigorous numerical computations for 1D advection equations.",
        abstract: "Validated numerics for partial differential equations with interval enclosures."
      })
    ],
    claims: []
  });

  assert.equal(report.counts.offTopicSources, 0);
  assert.notEqual(report.sourceRelevance[0]?.rationale, "The source does not match the Riemann-zeta-zero scope required by the brief.");
});

test("verifier does not contain autonomous-agent-specific relevance overrides", () => {
  const report = verifyResearchClaims({
    brief: {
      topic: "autonomous research agents for literature review automation",
      researchQuestion: "How can autonomous research agents perform high-quality literature reviews?",
      researchDirection: "Review retrieval, summarization, evidence organization, and evaluation.",
      successCriterion: "Use only on-topic evidence about literature review automation or evidence synthesis."
    },
    papers: [
      canonicalPaper({
        id: "paper-colloid-ai",
        key: "doi:10.1000/colloid-ai",
        title: "Artificial intelligence in colloid and interface science",
        citation: "Example Author (2024). Artificial intelligence in colloid and interface science.",
        abstract: "A review of machine-learning applications for materials discovery."
      })
    ],
    claims: []
  });

  assert.equal(report.counts.offTopicSources, 0);
  assert.notEqual(report.sourceRelevance[0]?.rationale, "The source does not match the autonomous research-agent review scope.");
});
