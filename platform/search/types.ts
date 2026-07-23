/**
 * Generic query options for domain-agnostic search execution.
 */
export interface SearchQueryOptions {
  q?: string;
  category?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  cursor?: string;
}

/**
 * Stable, domain-agnostic SearchResultItem contract.
 * `resourceType` explicitly identifies the underlying aggregate model.
 */
export interface SearchResultItem {
  id: string;
  category: string;
  resourceType: "ClinicalNote" | "Observation" | "MedicationAdministration" | "LabOrder" | "DischargeDocument";
  title: string;
  snippet: string;
  score: number; // Relative relevance score (for sorting within result set)
  occurredAt: Date;
  resourceRef: {
    resourceId: string;
    link: string;
  };
}

/**
 * Paginated search response.
 */
export interface SearchQueryResponse {
  items: SearchResultItem[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}
