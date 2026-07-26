import { describe, it, expect } from "vitest";
import { knowledgeRetrievalEngine } from "../services/ai/KnowledgeRetrievalEngine.ts";
import { clinicalKnowledgeBase } from "../services/ai/ClinicalKnowledgeBase.ts";

describe("Phase 4: Knowledge Layer Tests", () => {
  it("should query ClinicalKnowledgeBase and retrieve relevant asthma evidence", () => {
    const res = knowledgeRetrievalEngine.search("What is the acute protocol for severe asthma?");

    expect(res.matchedEntries.length).toBeGreaterThanOrEqual(1);
    expect(res.matchedEntries[0].title).toContain("Asthma");
    expect(res.citations[0]).toContain("GINA");
    expect(res.evidenceText).toContain("Albuterol");
  });

  it("should query drug interaction rules and retrieve potassium risk guidance", () => {
    const res = knowledgeRetrievalEngine.search("Check interaction between lisinopril and spironolactone");

    expect(res.matchedEntries.length).toBeGreaterThanOrEqual(1);
    expect(res.evidenceText).toContain("hyperkalemia");
    expect(res.citations).toBeDefined();
  });
});
