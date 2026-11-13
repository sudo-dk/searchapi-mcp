# searchapi-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[SearchApi.io](https://www.searchapi.io). It gives any MCP client (Claude
Desktop, Cursor, or your own agent) live, structured results from Google, Google
Jobs, Shopping, News, Scholar, Maps, YouTube and 100+ other engines, trimmed
down to what a model actually needs.

## Why trimming matters

Raw SERP JSON is designed to be complete, not to fit in a context window. One
Google Shopping response is about 217 KB, mostly base64 thumbnails and
multi-KB product tokens. Passing that to a model costs tens of thousands of
tokens and pushes out everything else in the conversation. Each tool here
keeps only the fields an agent reasons with: titles, prices, dates, authors,
citation counts, links and pagination.

Measured on live responses (Nov 2026):

| Engine | Raw response | Tool output | Smaller by |
|---|---|---|---|
| `google_shopping` (10 items) | 217 KB | 5.0 KB | 43× |
| `google_jobs` | 121 KB | 17.1 KB | 7× |
| `google` | 54 KB | 8.3 KB | 6× |
| `google_news` | 45 KB | 9.5 KB | 5× |
| `youtube` | 31 KB | 7.4 KB | 4× |
| `google_maps` | 29 KB | 7.3 KB | 4× |
| `google_scholar` | 26 KB | 5.8 KB | 4× |

## Tools

| Tool | Engine | Key parameters | Returns |
|---|---|---|---|
| `google_search` | `google` | `q`, `location`, `gl`, `hl`, `time_period`, `page` | Organic results, AI overview, answer box, knowledge graph, related questions |
| `google_news` | `google_news` | `q`, `location`, `time_period`, `sort_by`, `page` | Articles with ISO dates, top stories |
| `google_jobs` | `google_jobs` | `q`, `location`, `next_page_token` | Title, company, location, schedule/salary, description excerpt, apply link |
| `google_shopping` | `google_shopping` | `q`, `location`, `price_min`, `price_max`, `max_results`, `page` | Title, price, seller, rating, reviews, delivery |
| `google_scholar` | `google_scholar` | `q`, `as_ylo`, `as_yhi`, `num`, `page` | Title, authors, publication, citation count, PDF link |
| `youtube_search` | `youtube` | `q`, `gl`, `hl`, `page_token` | Title, channel, views, length, publish time |
| `search` | any | `engine`, `q`, `extra_params` | Engine-specific shaping where available (e.g. `google_maps`), otherwise a generic clean-up plus `available_keys` |

Every tool returns the same envelope:

- `results` and `result_count`, always.
- `next_page` when there's more. Pass it back to the same tool to get the next page.
- `notice` when SearchApi returns no results. This is not a tool error, so the agent can try something else.

See [examples/](./examples) for real outputs and prompts to try.

## Setup

```bash
git clone https://github.com/<you>/searchapi-mcp.git
cd searchapi-mcp
npm install
npm run build
```

Get an API key at [searchapi.io](https://www.searchapi.io).

## Use with Claude Desktop

Add the server to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on
Windows), then restart Claude Desktop.

```json
{
  "mcpServers": {
    "searchapi": {
      "command": "node",
      "args": ["/absolute/path/to/searchapi-mcp/dist/index.js"],
      "env": { "SEARCHAPI_API_KEY": "your_key_here" }
    }
  }
}
```

If you'd rather not keep the key in the Claude config, put it in the project's
`.env` and let Node load it (Node 20.6+):

```json
{
  "mcpServers": {
    "searchapi": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--env-file=/absolute/path/to/searchapi-mcp/.env",
        "/absolute/path/to/searchapi-mcp/dist/index.js"
      ]
    }
  }
}
```

Claude Desktop doesn't inherit your shell's `PATH`. If `node` isn't found, use
the absolute path from `which node`.

## Development

```bash
cp .env.example .env   # add your key
npm test               # offline unit tests against recorded responses
npm run smoke          # live end-to-end check over MCP (~10 searches)
```

- `src/searchapi.ts`: the HTTP client and the trimming rules for each engine.
- `src/index.ts`: the MCP tool definitions.
- `test/fixtures/`: real SearchApi responses, cut down to a few items each.
- `scripts/smoke.mjs`: a minimal MCP client that calls every tool against the live API.

## Notes

- **Google Jobs coverage:** Google Jobs isn't available in every country. In
  testing it returned listings for the US, UK and Canada but none for Finland,
  Sweden or Germany. SearchApi rejects `gl=fi` for this engine outright.
- The API key is sent in the `Authorization` header, never in the URL, so it
  can't end up in error messages or logs.
- Server logs go to stderr so they never corrupt the stdio JSON-RPC channel.
- This is an independent open-source wrapper of SearchApi's public API, not an
  official SearchApi product.

## License

MIT, see [LICENSE](./LICENSE).
