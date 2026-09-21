export interface WebSearchInput {
  query: string;
  maxSources?: number;
  freshness?: "cached" | "live";
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchDetails {
  query: string;
  freshness: "cached" | "live";
  sourceCount: number;
  sources: WebSearchSource[];
  summary: string;
  truncated: boolean;
  /** True while the answer is being streamed from the backend. */
  streaming?: boolean;
  /** Every query the backend executed, across all search calls. */
  searchedQueries?: string[];
  /** How many search calls the backend made. */
  searchCallCount?: number;
  /** The model that produced the answer. */
  model?: string;
  /** Reasoning effort sent with the request, when one was set. */
  reasoningEffort?: string | null;
}
