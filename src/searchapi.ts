/**
 * SearchApi client + per-engine response shaping.
 *
 * Kept separate from the MCP wiring so it can be unit-tested with recorded
 * responses and an injected fetch.
 *
 * Why shaping matters: raw SearchApi responses are built for completeness, not
 * for an LLM's context window. Measured on live responses (Nov 2026), a single
 * google_shopping call is ~216 KB and google_jobs ~120 KB — mostly base64
 * favicons/thumbnails, multi-KB product tokens and full job descriptions. Each
 * engine below keeps the fields an agent actually reasons over.
 */

export const API_BASE = "https://www.searchapi.io/api/v1/search";
export const VERSION = "0.2.0";

/** Hard ceiling on what a single tool call returns to the model. */
export const MAX_OUTPUT_CHARS = 40_000;

export type Params = Record<string, string | number | boolean | undefined | null>;
export type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export class SearchApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SearchApiError";
  }
}

/** Params a caller must never be able to override via extra_params. */
const RESERVED_PARAMS = new Set(["engine", "api_key"]);

export interface ClientOptions {
  apiKey: string | undefined;
  fetch?: FetchLike;
  userAgent?: string;
}

/** Build the request URL. `engine` is set last so params can't override it. */
export function buildUrl(engine: string, params: Params): URL {
  const url = new URL(API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("engine", engine);
  return url;
}

export function createClient({ apiKey, fetch: fetchImpl = fetch, userAgent }: ClientOptions) {
  return async function search(engine: string, params: Params): Promise<any> {
    if (!apiKey) {
      throw new SearchApiError(
        "SEARCHAPI_API_KEY is not set. Get a key at https://www.searchapi.io and pass it " +
          "to the server via the SEARCHAPI_API_KEY environment variable."
      );
    }

    let res: Response;
    try {
      res = await fetchImpl(buildUrl(engine, params), {
        headers: {
          // Key goes in a header, never the URL, so it can't leak into logs/errors.
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": userAgent ?? `searchapi-mcp/${VERSION}`,
        },
      });
    } catch (err) {
      throw new SearchApiError(
        `Could not reach SearchApi: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const body = await res.text();
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new SearchApiError(
        `SearchApi returned a non-JSON response (HTTP ${res.status}): ${body.slice(0, 300)}`,
        res.status
      );
    }

    if (!res.ok) {
      // Error bodies look like {"error": "Unsupported engine: `foo`."}
      const detail = typeof json?.error === "string" ? json.error : body.slice(0, 300);
      throw new SearchApiError(`SearchApi error (HTTP ${res.status}): ${detail}`, res.status);
    }
    return json;
  };
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

/** Copy only the listed keys that are present (not undefined/null/""). */
function pick(obj: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Some sources (e.g. Google Jobs descriptions) arrive as HTML; flatten to text. */
export function htmlToText(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  return s
    .replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

const HEAVY_KEYS = new Set([
  "favicon",
  "thumbnail",
  "thumbnails",
  "image",
  "images",
  "product_token",
  "link_token",
  "page_token",
  "serpapi_link",
  "snippet_highlighted_words",
]);

/**
 * Generic deep clean for blobs we pass through less selectively (answer box,
 * knowledge graph, unknown engines): drops image/token fields and any inline
 * base64 data URI.
 */
export function stripHeavy(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (typeof value === "string") return value.startsWith("data:") ? undefined : value;
  if (Array.isArray(value)) {
    return value.map((v) => stripHeavy(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (HEAVY_KEYS.has(k)) continue;
      const cleaned = stripHeavy(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function searchInfo(data: any): Record<string, unknown> | undefined {
  const info = pick(data.search_information, [
    "query_displayed",
    "total_results",
    "detected_location",
    "spelling_fix",
    "showing_results_for",
  ]);
  return Object.keys(info).length ? info : undefined;
}

/** Page-number pagination (google, news, shopping, scholar, bing). */
function nextPageNumber(data: any): number | undefined {
  const p = data.pagination;
  if (!p?.next) return undefined;
  const current = Number(p.current ?? data.search_parameters?.page ?? 1);
  return Number.isFinite(current) ? current + 1 : undefined;
}

// ---------------------------------------------------------------------------
// Per-engine shaping
// ---------------------------------------------------------------------------

interface EngineShape {
  /** Field holding the primary result list. */
  resultsKey: string;
  /** Trim one result item. */
  item: (r: any) => Record<string, unknown>;
  /** Extra top-level context worth keeping (answer box, top stories, …). */
  extras?: (data: any) => Record<string, unknown>;
  /** How the agent asks for the next page. */
  next?: (data: any) => Record<string, unknown> | undefined;
}

const webResult = (r: any) => pick(r, ["position", "title", "link", "source", "snippet", "date"]);

export const ENGINES: Record<string, EngineShape> = {
  google: {
    resultsKey: "organic_results",
    item: webResult,
    extras: (d) => ({
      answer_box: d.answer_box ? stripHeavy(d.answer_box) : undefined,
      knowledge_graph: d.knowledge_graph ? stripHeavy(d.knowledge_graph) : undefined,
      // ai_overview.markdown is the compact form; text_blocks/reference_links
      // repeat it with Google redirect URLs.
      ai_overview: truncate(d.ai_overview?.markdown, 4_000),
      related_questions: Array.isArray(d.related_questions)
        ? d.related_questions.map((q: any) => q.question).filter(Boolean)
        : undefined,
    }),
    next: (d) => {
      const page = nextPageNumber(d);
      return page ? { page } : undefined;
    },
  },

  bing: {
    resultsKey: "organic_results",
    item: webResult,
    extras: (d) => ({ ai_overview: truncate(d.ai_overview?.markdown, 4_000) }),
    next: (d) => {
      const page = nextPageNumber(d);
      return page ? { page } : undefined;
    },
  },

  google_news: {
    resultsKey: "organic_results",
    item: (r) => ({
      ...pick(r, ["position", "title", "link", "source", "snippet"]),
      date: r.iso_date ?? r.date,
    }),
    extras: (d) => ({
      top_stories: Array.isArray(d.top_stories)
        ? d.top_stories.map((s: any) => ({
            ...pick(s, ["title", "link", "source"]),
            date: s.iso_date ?? s.date,
          }))
        : undefined,
    }),
    next: (d) => {
      const page = nextPageNumber(d);
      return page ? { page } : undefined;
    },
  },

  google_jobs: {
    resultsKey: "jobs",
    item: (r) => ({
      ...pick(r, ["position", "title", "company_name", "location", "via"]),
      ...pick(r.detected_extensions, ["posted_at", "schedule", "salary", "work_from_home"]),
      // Full descriptions run 3-4 KB each; the opening is enough to judge fit.
      description: truncate(htmlToText(r.description), 600),
      apply_link: r.apply_link,
      job_id: r.job_id,
    }),
    next: (d) =>
      d.pagination?.next_page_token ? { next_page_token: d.pagination.next_page_token } : undefined,
  },

  google_shopping: {
    resultsKey: "shopping_results",
    item: (r) =>
      pick(r, [
        "position",
        "title",
        "price",
        "extracted_price",
        "original_price",
        "seller",
        "rating",
        "reviews",
        "delivery",
        "tag",
        "product_id",
        "product_link",
      ]),
    next: (d) => {
      const page = nextPageNumber(d);
      return page ? { page } : undefined;
    },
  },

  google_scholar: {
    resultsKey: "organic_results",
    item: (r) => ({
      ...pick(r, ["position", "title", "link", "publication", "snippet"]),
      authors: Array.isArray(r.authors) ? r.authors.map((a: any) => a.name).filter(Boolean) : undefined,
      cited_by: r.inline_links?.cited_by?.total,
      cites_id: r.inline_links?.cited_by?.cites_id,
      pdf: r.resource?.format === "PDF" ? r.resource.link : undefined,
    }),
    next: (d) => {
      const page = nextPageNumber(d);
      return page ? { page } : undefined;
    },
  },

  google_maps: {
    resultsKey: "local_results",
    item: (r) =>
      pick(r, [
        "position",
        "title",
        "type",
        "address",
        "rating",
        "reviews",
        "price",
        "open_state",
        "hours",
        "phone",
        "website",
        "gps_coordinates",
        "place_id",
      ]),
  },

  youtube: {
    resultsKey: "videos",
    item: (r) => ({
      ...pick(r, ["position", "id", "title", "link", "length", "published_time", "live"]),
      views: r.extracted_views ?? r.views,
      channel: r.channel?.title,
      channel_verified: r.channel?.is_verified ?? r.channel?.verified,
      description: truncate(r.description, 300),
    }),
    next: (d) =>
      d.pagination?.next_page_token ? { page_token: d.pagination.next_page_token } : undefined,
  },
};

/** Arrays that are never the "main" results of an unknown engine. */
const NON_RESULT_ARRAYS = new Set([
  "related_searches",
  "related_questions",
  "filters",
  "ads",
  "local_ads",
  "shopping_ads",
]);

function fallbackResultsKey(data: any): string | undefined {
  if (Array.isArray(data.organic_results)) return "organic_results";
  for (const [k, v] of Object.entries(data)) {
    if (NON_RESULT_ARRAYS.has(k)) continue;
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return k;
  }
  return undefined;
}

function dropEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export interface Summary {
  engine: string;
  search_information?: Record<string, unknown>;
  results: unknown[];
  result_count: number;
  /** Set when SearchApi returned 200 with an `error` (e.g. "didn't return any results"). */
  notice?: string;
  /** Pass these params back to the same tool to get the next page. */
  next_page?: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * Shape a raw SearchApi response for an LLM.
 * `limit` caps the number of result items (shopping returns 40 by default).
 */
export function summarize(engine: string, data: any, limit?: number): Summary {
  if (data == null || typeof data !== "object") {
    return { engine, results: [], result_count: 0, notice: "Empty response from SearchApi." };
  }

  const shape = ENGINES[engine];
  const key = shape?.resultsKey ?? fallbackResultsKey(data);
  const raw: any[] = key && Array.isArray(data[key]) ? data[key] : [];
  const items = typeof limit === "number" ? raw.slice(0, limit) : raw;
  const results = shape
    ? items.map((r) => dropEmpty(shape.item(r)))
    : (stripHeavy(items) as unknown[]);

  const summary: Summary = {
    engine,
    ...dropEmpty({ search_information: searchInfo(data) }),
    ...(shape?.extras ? dropEmpty(shape.extras(data)) : {}),
    results,
    result_count: results.length,
  };

  if (typeof data.error === "string") summary.notice = data.error;
  if (!shape) {
    summary.results_key = key ?? null;
    summary.available_keys = Object.keys(data).filter(
      (k) => k !== "search_metadata" && k !== "search_parameters"
    );
  }
  const next = shape?.next?.(data);
  if (next) summary.next_page = next;
  return summary;
}

/**
 * Serialize for the model, enforcing MAX_OUTPUT_CHARS by dropping trailing results.
 * Compact JSON on purpose: indentation is ~15-25% of a pretty-printed payload
 * and models read compact JSON just as well.
 */
export function render(summary: Summary, maxChars = MAX_OUTPUT_CHARS): string {
  let text = JSON.stringify(summary);
  if (text.length <= maxChars) return text;

  const s: Summary = { ...summary, results: [...summary.results] };
  while (s.results.length > 1 && text.length > maxChars) {
    s.results.pop();
    s.result_count = s.results.length;
    s.truncated = `Output capped at ${maxChars} chars; showing ${s.results.length} of ${summary.results.length} results.`;
    text = JSON.stringify(s);
  }
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n…[truncated]";
}
