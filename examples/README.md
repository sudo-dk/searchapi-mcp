# Examples

## Prompts to try in Claude Desktop

Once the server is connected (see the main [README](../README.md)), ask in plain
language. Claude picks the tool and parameters itself.

| Prompt | Tool Claude calls |
|---|---|
| "What changed in the MCP spec this month?" | `google_search` with `time_period: "last_month"` |
| "Latest news on SearchApi, newest first." | `google_news` with `sort_by: "most_recent"` |
| "Find AI engineer roles in London and summarise which ones mention MCP." | `google_jobs`, then `next_page` for more |
| "Cheapest 75% mechanical keyboard under $100 with 4.5+ stars?" | `google_shopping` with `price_max: 100` |
| "Most-cited RAG papers since 2024, with PDF links." | `google_scholar` with `as_ylo: 2024` |
| "Best recent YouTube tutorial on building an MCP server?" | `youtube_search` |
| "Coffee shops near Kamppi, Helsinki." | `search` with `engine: "google_maps"` |

## What a tool returns

Real outputs, shortened to one or two results. Each response has the same
envelope: `engine`, `search_information`, `results`, `result_count`, plus
`next_page` when there is more, `notice` when SearchApi had nothing to return,
and engine-specific extras (`ai_overview`, `top_stories`, …).

### `google_shopping` — `{ "q": "mechanical keyboard", "max_results": 2 }`

```json
{
  "engine": "google_shopping",
  "search_information": {
    "query_displayed": "mechanical keyboard",
    "detected_location": "Cherokee County, Georgia"
  },
  "results": [
    {
      "position": 1,
      "title": "Womier DUO87 Mechanical Keyboard Detachable Smart Display",
      "price": "$124.99",
      "extracted_price": 124.99,
      "original_price": "$158",
      "seller": "Womier Keyboard",
      "rating": 4.4,
      "reviews": 5,
      "delivery": "Free delivery",
      "tag": "20% OFF",
      "product_id": "2029672877353520273",
      "product_link": "https://www.google.com/search?ibp=oshop&q=mechanical+keyboard&prds=catalogid:2029672877353520273,…"
    },
    {
      "position": 2,
      "title": "Logitech G316 X 98 Gaming Keyboard",
      "price": "$90.99",
      "extracted_price": 90.99,
      "seller": "Best Buy",
      "rating": 4.8,
      "reviews": 92,
      "delivery": "Free delivery by Tue",
      "tag": "24% OFF",
      "product_id": "18147754438381160995",
      "product_link": "https://www.google.com/search?ibp=oshop&q=mechanical+keyboard&prds=catalogid:18147754438381160995,…"
    }
  ],
  "result_count": 2
}
```

### `google_jobs` — `{ "q": "AI engineer" }`

The description is converted from HTML to text and cut at 600 characters.
To get the next page, pass `next_page` back to the tool unchanged.

```json
{
  "engine": "google_jobs",
  "search_information": { "query_displayed": "AI engineer", "detected_location": "Miami Gardens, FL" },
  "results": [
    {
      "position": 1,
      "title": "AI Engineering Consultant",
      "company_name": "Accenture Plc",
      "location": "Miami, FL",
      "via": "via Monster",
      "schedule": "Full-time",
      "description": "We Are: Accenture is a leading global professional services company that helps … We combine our strength in tech…",
      "apply_link": "https://www.monster.com/job-openings/ai-engineering-consultant-miami-fl--dc0ab7d9-…",
      "job_id": "EswBCowBQUREYldl…"
    }
  ],
  "result_count": 1,
  "next_page": { "next_page_token": "eyJmYyI6IkVx…" }
}
```

### `google_jobs` when there is no coverage

Google Jobs isn't available in every country. In that case SearchApi responds
with HTTP 200 and an `error` field. The server passes that on as a `notice`,
not as a tool error, so the agent can fall back to another tool:

```json
{
  "engine": "google_jobs",
  "results": [],
  "result_count": 0,
  "notice": "Google Jobs didn't return any results."
}
```

### `google_scholar` — `{ "q": "retrieval augmented generation" }`

```json
{
  "engine": "google_scholar",
  "search_information": { "query_displayed": "retrieval augmented generation", "total_results": 1360000 },
  "results": [
    {
      "position": 1,
      "title": "Retrieval-augmented generation for knowledge-intensive nlp tasks",
      "link": "https://proceedings.neurips.cc/paper_files/paper/2020/hash/6b493230-Abstract.html",
      "publication": "P Lewis, E Perez, A Piktus, F Petroni… - Advances in neural …, 2020 - proceedings.neurips.cc",
      "authors": ["P Lewis", "E Perez", "A Piktus", "F Petroni"],
      "cited_by": 34653,
      "cites_id": "10679876450978666441"
    }
  ],
  "result_count": 1,
  "next_page": { "page": 2 }
}
```

## Calling the server from code

[`scripts/smoke.mjs`](../scripts/smoke.mjs) is a short, complete MCP client.
It starts the server over stdio, lists the tools, calls each one and follows a
`next_page` token. Use it as a starting point for your own agent:

```bash
npm run smoke   # needs SEARCHAPI_API_KEY in .env; uses ~10 searches
```
