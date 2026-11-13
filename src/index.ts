#!/usr/bin/env node
/**
 * SearchApi MCP server
 * -----------------------------------------------------------------------------
 * Exposes SearchApi.io (https://www.searchapi.io) as Model Context Protocol
 * tools so any MCP client — Claude Desktop, Cursor, an agent framework — can
 * pull live, structured search results instead of relying on stale model data.
 *
 * SearchApi is a single REST endpoint where the `engine` parameter selects the
 * source. Each tool below exposes the parameters that engine actually supports
 * (per https://www.searchapi.io/docs) and returns a compact, LLM-sized summary
 * — see src/searchapi.ts for the shaping.
 *
 * Auth: set SEARCHAPI_API_KEY in the environment. Never commit your key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, render, summarize, VERSION, type Params } from "./searchapi.js";

const search = createClient({ apiKey: process.env.SEARCHAPI_API_KEY });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(engine: string, params: Params, limit?: number): Promise<ToolResult> {
  try {
    const data = await search(engine, params);
    return { content: [{ type: "text", text: render(summarize(engine, data, limit)) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

// --- Shared parameter schemas ----------------------------------------------

const q = z.string().min(1).describe("The search query.");
const location = z
  .string()
  .optional()
  .describe(
    'Location to search from, e.g. "Helsinki, Finland" or "Austin, Texas". Without it ' +
      "SearchApi picks a location, so set it for anything local."
  );
const gl = z.string().length(2).optional().describe('Two-letter country code, e.g. "us", "fi".');
const hl = z.string().optional().describe('Interface language code, e.g. "en", "fi".');
const page = z.number().int().min(1).optional().describe("Results page, starting at 1.");
const timePeriod = z
  .enum(["last_hour", "last_day", "last_week", "last_month", "last_year"])
  .optional()
  .describe("Only return results from this recent time window.");

const PAGING_NOTE =
  " If the response contains `next_page`, pass those parameters back to get more results.";

const server = new McpServer({ name: "searchapi-mcp", version: VERSION });

server.registerTool(
  "google_search",
  {
    title: "Google Search",
    description:
      "Live Google web search. Use for current, factual or post-training-cutoff " +
      "information. Returns organic results plus Google's AI overview, answer box, " +
      "knowledge graph and related questions when present." +
      PAGING_NOTE,
    inputSchema: { q, location, gl, hl, time_period: timePeriod, page },
  },
  async (args) => run("google", args)
);

server.registerTool(
  "google_news",
  {
    title: "Google News",
    description:
      "Search Google News for recent articles. Returns articles (title, source, " +
      "ISO date, snippet, link) and top stories." +
      PAGING_NOTE,
    inputSchema: {
      q,
      location,
      gl,
      hl,
      time_period: timePeriod,
      sort_by: z
        .enum(["most_recent"])
        .optional()
        .describe('Set to "most_recent" for newest first; default is relevance.'),
      page,
    },
  },
  async (args) => run("google_news", args)
);

server.registerTool(
  "google_jobs",
  {
    title: "Google Jobs",
    description:
      "Search job listings aggregated by Google Jobs. Returns title, company, " +
      "location, source site, schedule/salary/posting age when known, the start of " +
      "the description and an apply link. Put the role in `q` and the place in " +
      "`location`. Google Jobs is not available in every country (it returned no " +
      "listings for Finland, Sweden and Germany in testing); if you get a " +
      "'didn't return any results' notice, fall back to google_search." +
      PAGING_NOTE,
    inputSchema: {
      q,
      location,
      gl,
      hl,
      next_page_token: z
        .string()
        .optional()
        .describe("Token from a previous response's next_page to fetch more listings."),
    },
  },
  async (args) => run("google_jobs", args)
);

server.registerTool(
  "google_shopping",
  {
    title: "Google Shopping",
    description:
      "Search Google Shopping for products. Returns title, price, seller, rating, " +
      "review count and delivery info — use for price checks and comparisons." +
      PAGING_NOTE,
    inputSchema: {
      q,
      location,
      gl,
      hl,
      price_min: z.number().min(0).optional().describe("Minimum price."),
      price_max: z.number().min(0).optional().describe("Maximum price."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Max products to return (default 10; a page holds up to ~40)."),
      page,
    },
  },
  async ({ max_results, ...args }) => run("google_shopping", args, max_results ?? 10)
);

server.registerTool(
  "google_scholar",
  {
    title: "Google Scholar",
    description:
      "Search Google Scholar for academic papers. Returns title, authors, " +
      "publication, snippet, citation count, a cites_id and a PDF link when " +
      "available." +
      PAGING_NOTE,
    inputSchema: {
      q,
      hl,
      as_ylo: z.number().int().optional().describe("Only papers published in or after this year."),
      as_yhi: z.number().int().optional().describe("Only papers published in or before this year."),
      num: z.number().int().min(1).max(20).optional().describe("Results per page (1-20, default 10)."),
      page,
    },
  },
  async (args) => run("google_scholar", args)
);

server.registerTool(
  "youtube_search",
  {
    title: "YouTube Search",
    description:
      "Search YouTube videos. Returns title, channel, views, length, publish time " +
      "and link." +
      PAGING_NOTE,
    inputSchema: {
      q,
      gl,
      hl,
      page_token: z
        .string()
        .optional()
        .describe("Token from a previous response's next_page to fetch more videos."),
    },
  },
  // SearchApi's YouTube engine takes the next-page token in the `sp` param.
  async ({ page_token, ...args }) => run("youtube", { ...args, sp: page_token })
);

server.registerTool(
  "search",
  {
    title: "Any SearchApi engine",
    description:
      "Escape hatch for any SearchApi engine without a dedicated tool, e.g. " +
      "google_maps (places), bing, amazon_search, google_images, google_finance. See " +
      "https://www.searchapi.io/docs for engine names and parameters. Pass engine " +
      "and q; any other documented parameter goes in extra_params. The response " +
      "lists `available_keys` so you can tell what the engine returned.",
    inputSchema: {
      engine: z.string().min(1).describe('SearchApi engine name, e.g. "bing", "google_maps".'),
      q,
      location,
      gl,
      hl,
      extra_params: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional engine parameters as strings, e.g. {\"page\": \"2\"}."),
    },
  },
  async ({ engine, extra_params, ...rest }) => run(engine, { ...(extra_params ?? {}), ...rest })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC channel.
  console.error(`searchapi-mcp ${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
