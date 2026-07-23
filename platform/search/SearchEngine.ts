import type { SearchQueryOptions, SearchResultItem, SearchQueryResponse } from "./types.ts";

/**
 * SearchEngine — generic, domain-agnostic text query execution engine.
 *
 * Responsibilities:
 * - Tokenize query strings and compute relative relevance scores.
 * - Safely escape regular expressions for text matching.
 * - Filter, sort deterministically, and paginate SearchResultItem arrays.
 * - Zero imports from models/ or clinical services.
 */
export class SearchEngine {
  /**
   * Safely escapes special regex characters in a raw search string.
   */
  public static escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Tokenizes a text string into normalized, lowercased terms.
   */
  public static tokenize(text: string): string[] {
    if (!text) return [];
    return text
      .toLowerCase()
      .split(/[\s,._\-\/\:\;]+/)
      .filter((t) => t.length > 1);
  }

  /**
   * Calculates a relative relevance score for a target text block against search tokens.
   */
  public static calculateRelevanceScore(targetText: string, searchTokens: string[]): number {
    if (!targetText || searchTokens.length === 0) return 0;
    const lowerTarget = targetText.toLowerCase();

    let score = 0;
    for (const token of searchTokens) {
      if (lowerTarget.includes(token)) {
        score += 10;
        // Exact word match bonus
        const regex = new RegExp(`\\b${SearchEngine.escapeRegex(token)}\\b`, "i");
        if (regex.test(targetText)) {
          score += 15;
        }
      }
    }
    return score;
  }

  /**
   * Filters, ranks deterministically, and paginates a candidate set of SearchResultItems.
   * Ranking rules:
   * 1. Relative relevance score (descending)
   * 2. OccurredAt date (descending)
   * 3. ID string (ascending — for deterministic tie-breaking)
   */
  public static rankAndPaginate(
    items: SearchResultItem[],
    options: SearchQueryOptions = {}
  ): SearchQueryResponse {
    let filtered = [...items];

    // Filter by category if specified
    if (options.category && options.category !== "all") {
      filtered = filtered.filter((item) => item.category === options.category);
    }

    // Filter by date range if specified
    if (options.dateFrom) {
      filtered = filtered.filter((item) => new Date(item.occurredAt) >= options.dateFrom!);
    }
    if (options.dateTo) {
      filtered = filtered.filter((item) => new Date(item.occurredAt) <= options.dateTo!);
    }

    // Deterministic sorting: score (desc) → occurredAt (desc) → id (asc)
    filtered.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const timeDiff = new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.id.localeCompare(b.id);
    });

    const totalCount = filtered.length;
    const limit = Math.max(1, Math.min(options.limit || 20, 100));

    // Handle cursor pagination
    let startIndex = 0;
    if (options.cursor) {
      try {
        const decodedIndex = parseInt(Buffer.from(options.cursor, "base64").toString("utf-8"), 10);
        if (!isNaN(decodedIndex) && decodedIndex >= 0) {
          startIndex = decodedIndex;
        }
      } catch {
        startIndex = 0;
      }
    }

    const pageItems = filtered.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < totalCount;
    const nextCursor = hasMore ? Buffer.from(nextIndex.toString()).toString("base64") : undefined;

    return {
      items: pageItems,
      totalCount,
      hasMore,
      nextCursor,
    };
  }
}
