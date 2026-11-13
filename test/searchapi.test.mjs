// Offline tests for response shaping and the HTTP client. Fixtures in
// test/fixtures are real SearchApi responses (Nov 2026), trimmed to a few items.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildUrl,
  createClient,
  htmlToText,
  render,
  stripHeavy,
  summarize,
  SearchApiError,
} from "../dist/searchapi.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const noDataUris = (value) => assert.ok(!JSON.stringify(value).includes("data:image"));

// --- summarize: one test per engine ------------------------------------------

test("google: organic results, AI overview, related questions, page pagination", () => {
  const s = summarize("google", fixture("google"));
  assert.equal(s.result_count, 3);
  const allowed = new Set(["position", "title", "link", "source", "snippet", "date"]);
  for (const r of s.results) assert.ok(Object.keys(r).every((k) => allowed.has(k)), Object.keys(r).join());
  assert.ok(s.results[0].title && s.results[0].link);
  assert.equal(typeof s.ai_overview, "string");
  assert.ok(s.related_questions.every((q) => typeof q === "string"));
  assert.deepEqual(s.next_page, { page: 2 });
  noDataUris(s);
});

test("google_news: ISO dates and top stories", () => {
  const s = summarize("google_news", fixture("google_news"));
  assert.equal(s.result_count, 3);
  assert.match(s.results[0].date, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(s.top_stories.length > 0);
  assert.ok(!("thumbnail" in s.results[0]) && !("link_token" in s.results[0]));
});

test("google_jobs: HTML descriptions flattened and truncated, token pagination", () => {
  const s = summarize("google_jobs", fixture("google_jobs"));
  const job = s.results[0];
  assert.ok(job.title && job.company_name && job.apply_link);
  assert.ok(!/<[a-z]/i.test(job.description), "description should be plain text");
  assert.ok(job.description.length <= 601);
  assert.ok(!("job_highlights" in job) && !("sharing_link" in job));
  assert.equal(typeof s.next_page.next_page_token, "string");
});

test("google_jobs: 200-with-error becomes an empty result plus notice", () => {
  const s = summarize("google_jobs", fixture("google_jobs_no_results"));
  assert.equal(s.result_count, 0);
  assert.deepEqual(s.results, []);
  assert.match(s.notice, /didn't return any results/);
});

test("google_shopping: drops product tokens and thumbnails, honours limit", () => {
  const s = summarize("google_shopping", fixture("google_shopping"), 5);
  assert.equal(s.result_count, 5);
  for (const p of s.results) {
    assert.ok(p.title && p.price);
    assert.ok(!("product_token" in p) && !("thumbnail" in p));
  }
  noDataUris(s);
});

test("google_scholar: author names and citation counts", () => {
  const s = summarize("google_scholar", fixture("google_scholar"));
  const paper = s.results[0];
  assert.ok(Array.isArray(paper.authors) && typeof paper.authors[0] === "string");
  assert.equal(typeof paper.cited_by, "number");
  assert.deepEqual(s.next_page, { page: 2 });
});

test("youtube: flattened channel (live API uses is_verified) and page_token", () => {
  const s = summarize("youtube", fixture("youtube"));
  const v = s.results[0];
  assert.equal(typeof v.channel, "string");
  assert.equal(typeof v.channel_verified, "boolean");
  assert.equal(typeof v.views, "number");
  assert.ok(!("key_moments" in v) && !("thumbnail" in v));
  assert.equal(typeof s.next_page.page_token, "string");
});

test("google_maps: places with address, rating and coordinates", () => {
  const s = summarize("google_maps", fixture("google_maps"));
  const place = s.results[0];
  assert.ok(place.title && place.address);
  assert.equal(typeof place.rating, "number");
  assert.equal(typeof place.gps_coordinates.latitude, "number");
  assert.ok(!("open_hours" in place) && !("thumbnail" in place));
});

test("unknown engine: falls back to organic_results and reports available keys", () => {
  const data = fixture("bing");
  const s = summarize("some_new_engine", data);
  assert.equal(s.results_key, "organic_results");
  assert.equal(s.result_count, data.organic_results.length);
  assert.ok(s.available_keys.includes("organic_results"));
  assert.ok(!s.available_keys.includes("search_metadata"));
});

test("unknown engine: never treats related_searches/ads as the results", () => {
  const s = summarize("some_new_engine", {
    related_searches: [{ query: "a" }],
    ads: [{ title: "ad" }],
    places: [{ title: "Cafe" }],
  });
  assert.equal(s.results_key, "places");
});

test("summary is dramatically smaller than the raw response", () => {
  const raw = fixture("google_shopping");
  const out = render(summarize("google_shopping", raw, 10));
  assert.ok(out.length < JSON.stringify(raw).length / 4, `${out.length} chars`);
});

// --- helpers -----------------------------------------------------------------

test("render caps output by dropping trailing results", () => {
  const s = summarize("google_jobs", fixture("google_jobs"));
  const out = JSON.parse(render(s, 2_000));
  assert.ok(out.result_count < s.result_count);
  assert.match(out.truncated, /Output capped/);
});

test("stripHeavy removes base64 data URIs and image/token keys", () => {
  const cleaned = stripHeavy({
    title: "x",
    favicon: "data:image/png;base64,AAAA",
    nested: [{ img: "data:image/png;base64,BBBB", text: "keep" }],
    product_token: "abc",
  });
  assert.deepEqual(cleaned, { title: "x", nested: [{ text: "keep" }] });
});

test("htmlToText", () => {
  assert.equal(htmlToText("<p>Hello&nbsp;<b>world</b></p><ul><li>a &amp; b</li></ul>"), "Hello world a & b");
});

test("buildUrl: params can't override engine or inject api_key", () => {
  const url = buildUrl("google", { q: "x", engine: "bing", api_key: "leak", empty: "" });
  assert.equal(url.searchParams.get("engine"), "google");
  assert.equal(url.searchParams.get("api_key"), null);
  assert.equal(url.searchParams.has("empty"), false);
});

// --- client --------------------------------------------------------------------

const fakeFetch = (status, body, seen = {}) => async (url, init) => {
  seen.url = url;
  seen.init = init;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};

test("client sends the key as a Bearer header, never in the URL", async () => {
  const seen = {};
  const search = createClient({ apiKey: "secret123", fetch: fakeFetch(200, { ok: 1 }, seen) });
  await search("google", { q: "x" });
  assert.equal(seen.init.headers.Authorization, "Bearer secret123");
  assert.ok(!seen.url.toString().includes("secret123"));
});

test("client surfaces SearchApi's error message on HTTP errors", async () => {
  const search = createClient({
    apiKey: "k",
    fetch: fakeFetch(400, { error: "Unsupported engine: `nope`." }),
  });
  await assert.rejects(search("nope", { q: "x" }), (err) => {
    assert.ok(err instanceof SearchApiError);
    assert.equal(err.status, 400);
    assert.match(err.message, /HTTP 400.*Unsupported engine/);
    return true;
  });
});

test("client fails clearly without an API key", async () => {
  const search = createClient({ apiKey: undefined, fetch: fakeFetch(200, {}) });
  await assert.rejects(search("google", { q: "x" }), /SEARCHAPI_API_KEY is not set/);
});

test("client handles non-JSON bodies", async () => {
  const search = createClient({ apiKey: "k", fetch: fakeFetch(502, "<html>Bad Gateway</html>") });
  await assert.rejects(search("google", { q: "x" }), /non-JSON response \(HTTP 502\)/);
});
