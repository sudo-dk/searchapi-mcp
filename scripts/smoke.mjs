#!/usr/bin/env node
// Live end-to-end smoke test: spawns the built server over stdio, connects as an
// MCP client, and calls every tool against the real SearchApi.
//
//   npm run build && node --env-file=.env scripts/smoke.mjs
//
// Uses real API credits (~10 searches). Prints a one-line summary per call;
// never prints the API key.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.SEARCHAPI_API_KEY) {
  console.error("Set SEARCHAPI_API_KEY (e.g. node --env-file=.env scripts/smoke.mjs)");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

const cases = [
  ["google_search", { q: "model context protocol" }],
  ["google_news", { q: "SearchApi", sort_by: "most_recent" }],
  ["google_jobs", { q: "AI engineer", location: "London, United Kingdom" }],
  // Google Jobs has no coverage here: should come back as a notice, not an error.
  ["google_jobs", { q: "AI engineer", location: "Helsinki, Finland" }],
  ["google_shopping", { q: "mechanical keyboard", max_results: 5 }],
  ["google_scholar", { q: "retrieval augmented generation", as_ylo: 2024 }],
  ["youtube_search", { q: "MCP server tutorial" }],
  ["search", { engine: "bing", q: "searchapi.io" }],
  ["search", { engine: "not_a_real_engine", q: "x" }], // expected error
];

let failures = 0;
let lastJobs;

async function call(name, args) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const ms = Date.now() - started;
  // Page tokens are several KB; keep the log readable.
  const shown = JSON.stringify(args, (k, v) =>
    typeof v === "string" && v.length > 40 ? `${v.slice(0, 12)}…(${v.length} chars)` : v
  );
  if (res.isError) {
    console.log(`✗ ${name} ${shown}\n    error: ${text}`);
    return { error: text };
  }
  const data = JSON.parse(text);
  const first = data.results?.[0];
  const label = first?.title ?? first?.name ?? "(none)";
  console.log(
    `✓ ${name} ${shown}\n` +
      `    ${data.result_count} results, ${text.length} chars, ${ms} ms` +
      (data.notice ? ` | notice: ${data.notice}` : "") +
      (data.next_page ? ` | next_page: ${Object.keys(data.next_page).join(",")}` : "") +
      `\n    first: ${String(label).slice(0, 90)}`
  );
  return data;
}

for (const [name, args] of cases) {
  const out = await call(name, args);
  const expectError = args.engine === "not_a_real_engine";
  if (Boolean(out.error) !== expectError) failures++;
  if (name === "google_jobs" && out.next_page) lastJobs = { args, next: out.next_page };
}

// Pagination round-trip: feed next_page straight back into the tool.
if (lastJobs) {
  const page2 = await call("google_jobs", { ...lastJobs.args, ...lastJobs.next });
  if (page2.error || !page2.result_count) failures++;
}

await client.close();
console.log(failures ? `\n${failures} unexpected result(s)` : "\nAll calls behaved as expected.");
process.exit(failures ? 1 : 0);
