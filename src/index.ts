#!/usr/bin/env node
/**
 * SearchApi MCP server
 * -----------------------------------------------------------------------------
 * Exposes SearchApi.io (https://www.searchapi.io) as Model Context Protocol
 * tools so any MCP client — Claude Desktop, Cursor, an agent framework — can
 * pull live, structured search results instead of relying on stale model data.
 *
 * SearchApi is a single REST endpoint where the `engine` parameter selects the
 * source (google, google_jobs, google_shopping, youtube, google_scholar, bing,
 * google_news, and 100+ more). Every tool here is a thin, typed wrapper over
 * that endpoint.
 *
 * Auth: set SEARCHAPI_API_KEY in the environment. Never commit your key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://www.searchapi.io/api/v1/search";
const API_KEY = process.env.SEARCHAPI_API_KEY;
const USER_AGENT = "searchapi-mcp/0.1.0 (+https://github.com/)";

/** Shared result shape returned to the MCP client. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Call SearchApi with a given engine and params, returning parsed JSON.
 * Throws a readable Error on any non-2xx or transport failure.
 */
async function searchApi(
  engine: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  if (!API_KEY) {
    throw new Error(
      "SEARCHAPI_API_KEY is not set. Get a free key at https://www.searchapi.io and " +
        "pass it to the server via the SEARCHAPI_API_KEY environment variable."
    );
  }

  const url = new URL(API_BASE);
  url.searchParams.set("engine", engine);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    throw new Error(
      `Could not reach SearchApi: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SearchApi returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`SearchApi returned a non-JSON response: ${body.slice(0, 500)}`);
  }
}

/**
 * SearchApi responses are large. For an agent we want the useful part, not the
 * raw metadata. This trims each engine's response to its primary result array
 * and a few helpful fields, while still returning JSON the model can reason over.
 */
function summarize(engine: string, data: any): string {
  if (data == null || typeof data !== "object") {
    return JSON.stringify(data, null, 2);
  }

  // Prefer the array most relevant to each engine, fall back to the first array.
  const preferred: Record<string, string> = {
    google: "organic_results",
    bing: "organic_results",
    google_news: "organic_results",
    google_scholar: "organic_results",
    google_jobs: "jobs",
    google_shopping: "shopping_results",
    youtube: "videos",
  };

  const key = preferred[engine];
  const primary = (key && Array.isArray(data[key]) && data[key]) || firstArray(data);

  const out: Record<string, unknown> = {};
  if (data.search_information) out.search_information = data.search_information;
  if (data.answer_box) out.answer_box = data.answer_box;
  if (data.knowledge_graph) out.knowledge_graph = data.knowledge_graph;
  out.results = primary ?? [];
  if (Array.isArray(primary)) out.result_count = primary.length;

  return JSON.stringify(out, null, 2);
}

function firstArray(data: Record<string, any>): any[] | undefined {
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length) return v;
  return undefined;
}

const server = new McpServer({
  name: "searchapi-mcp",
  version: "0.1.0",
});

/** Params shared by most engines. */
const common = {
  q: z.string().describe("The search query."),
  location: z
    .string()
    .optional()
    .describe('Geographic location for results, e.g. "Helsinki, Finland".'),
  gl: z.string().optional().describe('Two-letter country code, e.g. "fi", "us".'),
  hl: z.string().optional().describe('Two-letter UI language code, e.g. "en", "fi".'),
  num: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results to request (1-100)."),
};

async function run(engine: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const data = await searchApi(engine, args as Record<string, string | number>);
    return textResult(summarize(engine, data));
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}

server.registerTool(
  "google_search",
  {
    title: "Google Search",
    description:
      "Live Google web search via SearchApi. Use when you need current, factual, " +
      "or post-training-cutoff information from the web. Returns organic results, " +
      "answer box and knowledge graph when present.",
    inputSchema: common,
  },
  async (args) => run("google", args)
);

server.registerTool(
  "google_jobs",
  {
    title: "Google Jobs",
    description:
      "Search Google Jobs listings. Returns job title, company, location, posting " +
      "age and description. Useful for job-market and hiring questions.",
    inputSchema: common,
  },
  async (args) => run("google_jobs", args)
);

server.registerTool(
  "google_shopping",
  {
    title: "Google Shopping",
    description:
      "Search Google Shopping for products. Returns titles, prices, sellers and " +
      "ratings — use for price checks and product comparisons.",
    inputSchema: common,
  },
  async (args) => run("google_shopping", args)
);

server.registerTool(
  "google_news",
  {
    title: "Google News",
    description: "Search Google News for recent articles on a topic.",
    inputSchema: common,
  },
  async (args) => run("google_news", args)
);

server.registerTool(
  "google_scholar",
  {
    title: "Google Scholar",
    description:
      "Search Google Scholar for academic papers and citations. Returns titles, " +
      "authors, publication info and citation counts.",
    inputSchema: common,
  },
  async (args) => run("google_scholar", args)
);

server.registerTool(
  "youtube_search",
  {
    title: "YouTube Search",
    description:
      "Search YouTube. Returns video titles, channels, view counts, lengths and links.",
    inputSchema: { q: common.q, gl: common.gl, hl: common.hl },
  },
  async (args) => run("youtube", args)
);

server.registerTool(
  "search",
  {
    title: "Generic SearchApi Query",
    description:
      "Escape hatch for any SearchApi engine not covered by a dedicated tool " +
      "(e.g. bing, baidu, amazon, google_maps, google_images). Pass the engine " +
      "name and the query; extra_params is merged into the request as-is.",
    inputSchema: {
      engine: z
        .string()
        .describe('SearchApi engine name, e.g. "bing", "amazon", "google_maps".'),
      q: z.string().describe("The search query."),
      location: common.location,
      gl: common.gl,
      hl: common.hl,
      extra_params: z
        .record(z.string())
        .optional()
        .describe("Optional extra query parameters, merged into the request."),
    },
  },
  async ({ engine, extra_params, ...rest }) =>
    run(String(engine), { ...rest, ...(extra_params ?? {}) })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC channel.
  console.error("searchapi-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
