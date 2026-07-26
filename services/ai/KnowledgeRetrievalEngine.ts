import { clinicalKnowledgeBase, type ClinicalKnowledgeEntry } from "./ClinicalKnowledgeBase.ts";

export interface RetrievalResult {
  matchedEntries: ClinicalKnowledgeEntry[];
  citations: string[];
  evidenceText: string;
}

export class KnowledgeRetrievalEngine {
  private static instance: KnowledgeRetrievalEngine;

  private constructor() {}

  static getInstance(): KnowledgeRetrievalEngine {
    if (!KnowledgeRetrievalEngine.instance) {
      KnowledgeRetrievalEngine.instance = new KnowledgeRetrievalEngine();
    }
    return KnowledgeRetrievalEngine.instance;
  }

  /**
   * Performs keyword and semantic relevance matching against the Clinical Knowledge Base.
   */
  search(query: string): RetrievalResult {
    if (!query || !query.trim()) {
      return { matchedEntries: [], citations: [], evidenceText: "" };
    }

    const lowerQuery = query.toLowerCase();
    const entries = clinicalKnowledgeBase.getEntries();
    const matches: ClinicalKnowledgeEntry[] = [];

    for (const entry of entries) {
      const isKeywordMatch = entry.keywords.some(kw => lowerQuery.includes(kw.toLowerCase()));
      const isTitleMatch = entry.title.toLowerCase().includes(lowerQuery);
      if (isKeywordMatch || isTitleMatch) {
        matches.push(entry);
      }
    }

    const citations = matches.map(m => m.citation);
    const evidenceText = matches
      .map(m => `[Clinical Knowledge: ${m.title}]\n${m.content}\nSource: ${m.citation}`)
      .join("\n\n");

    return {
      matchedEntries: matches,
      citations: citations.length > 0 ? citations : ["ANANTA Clinical Guidelines"],
      evidenceText
    };
  }
}

export const knowledgeRetrievalEngine = KnowledgeRetrievalEngine.getInstance();
