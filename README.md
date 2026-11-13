# searchapi-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[SearchApi.io](https://www.searchapi.io). It gives any MCP client — Claude
Desktop, Cursor, or an agent framework — live, structured results from Google,
Google Jobs, Google Shopping, Google News, Google Scholar, YouTube, and 100+
other sources, instead of relying on the model's training data.

One REST endpoint, one API key, typed tools your agent can call mid-task.

## Tools

| Tool | What it does |
|------|--------------|
| `google_search` | Live Google web search (organic results, answer box, knowledge graph) |
| `google_jobs` | Google Jobs listings |
| `google_shopping` | Products, prices and sellers |
| `google_news` | Recent news articles |
| `google_scholar` | Academic papers and citation counts |
| `youtube_search` | YouTube videos |
| `search` | Escape hatch for any other SearchApi engine (bing, amazon, google_maps, …) |

Each tool trims SearchApi's large JSON response down to the results array plus
answer box / knowledge graph when present, so the model gets signal, not noise.

## Setup

```bash
git clone https://github.com/<you>/searchapi-mcp.git
cd searchapi-mcp
npm install
npm run build
```

Get a free API key at [searchapi.io](https://www.searchapi.io), then set it in
your environment:

```bash
export SEARCHAPI_API_KEY=your_key_here
```

## Use with Claude Desktop

Add this to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS,
`%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "searchapi": {
      "command": "node",
      "args": ["/absolute/path/to/searchapi-mcp/dist/index.js"],
      "env": {
        "SEARCHAPI_API_KEY": "your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The SearchApi tools appear in the tools menu, and Claude
can call them whenever it needs live results.

## Use from the command line

Any MCP-compatible client that speaks stdio works. To sanity-check the server
is alive:

```bash
SEARCHAPI_API_KEY=your_key_here node dist/index.js
# -> "searchapi-mcp running on stdio"
```

## Example

Ask your agent: *"What AI engineer jobs are open in Helsinki right now?"* — it
calls `google_jobs` with `q: "AI engineer"`, `location: "Helsinki, Finland"` and
answers from live listings.

## Notes

- This is an independent open-source wrapper of SearchApi's public API, not an
  official SearchApi product.
- Your API key is read from the environment and never logged. Don't commit it.
- Logs go to stderr so they never corrupt the stdio JSON-RPC channel.

## License

MIT — see [LICENSE](./LICENSE).
