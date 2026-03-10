# pi-research-fabric

Cross-harness research capabilities for [Pi](https://github.com/badlogic/pi-mono).

This package adds four stable capability tools that are especially useful when migrating shared skills, prompts, or commands from other agent harnesses:

- `WebSearch`
- `WebFetch`
- `CodeContextSearch`
- `SiteMap`

Instead of rewriting every migrated skill for Pi-specific tools, you can install this package once and let it route requests to the best available provider.

## Why this exists

Many shared agent workflows assume conceptual tools like `WebSearch` and `WebFetch` exist everywhere.

Pi keeps its core lean, which is great, but it means multi-harness setups often need a compatibility layer. `pi-research-fabric` provides that layer for research-heavy workflows.

## What it does

### `WebSearch`
Harness-agnostic web discovery.

Routing order by default:
- Exa
- Brave Search
- Firecrawl

### `WebFetch`
Readable content extraction from a known URL.

Routing order by default:
- Firecrawl scrape
- direct HTTP fetch fallback

### `CodeContextSearch`
Code/documentation retrieval for implementation patterns and API examples.

Routing order by default:
- Exa code context

### `SiteMap`
Site discovery for documentation or content mapping.

Routing order by default:
- Firecrawl map

## Install

### Install from GitHub

```bash
pi install git:github.com/StartupBros/pi-research-fabric
```

### Try without installing

```bash
pi -e git:github.com/StartupBros/pi-research-fabric
```

## Required provider credentials

You only need credentials for the providers you actually want to use.

### Exa
Set either:
- `EXA_API_KEY`
- `EXA_MCP_API_KEY`

Optional:
- `EXA_MCP_URL`
- `EXA_MCP_TOOLS`
- `EXA_MCP_TIMEOUT_MS`
- `EXA_MCP_PROTOCOL_VERSION`

### Firecrawl
Set:
- `FIRECRAWL_API_KEY`

Optional:
- `FIRECRAWL_URL`
- `FIRECRAWL_TIMEOUT_MS`

### Brave Search
Set:
- `BRAVE_API_KEY`

## Config

This package reads config from either:
- `.pi/extensions/research-fabric.json`
- `~/.pi/agent/extensions/research-fabric.json`
- or `RESEARCH_FABRIC_CONFIG=/custom/path.json`

If no config exists, it writes a default global config file.

Example config:

```json
{
  "searchProviders": ["exa", "brave", "firecrawl"],
  "fetchProviders": ["firecrawl", "direct"],
  "codeContextProviders": ["exa"],
  "siteMapProviders": ["firecrawl"],
  "preferDynamicFetchForDomains": ["openai.com", "anthropic.com"],
  "cacheDir": "~/.pi/agent/cache/research-fabric",
  "searchTtlMs": 21600000,
  "fetchTtlMs": 86400000,
  "codeContextTtlMs": 86400000,
  "siteMapTtlMs": 86400000
}
```

A copy is included at [`examples/research-fabric.json`](./examples/research-fabric.json).

## Reusing existing Exa / Firecrawl config

If you already use Pi packages like:
- `@benvargas/pi-exa-mcp`
- `@benvargas/pi-firecrawl`

this package will also read:
- `.pi/extensions/exa-mcp.json`
- `~/.pi/agent/extensions/exa-mcp.json`
- `.pi/extensions/firecrawl.json`
- `~/.pi/agent/extensions/firecrawl.json`

That makes it easy to layer `pi-research-fabric` on top of an existing Pi setup.

## Notes on deep search

When `deep: true` is requested for `WebSearch`, Exa is currently invoked with a compatible configuration instead of an unsupported `deep` enum value. This keeps the tool working in environments where Exa only accepts `auto` or `fast` search modes.

## Caching

Results are cached on disk by default under:

```bash
~/.pi/agent/cache/research-fabric
```

Override with:
- `cacheDir` in config
- or `RESEARCH_FABRIC_CACHE_DIR`

## Example prompts

- "Use WebSearch to find the latest Next.js release notes."
- "Use CodeContextSearch to find React 19 useActionState examples."
- "Use WebFetch to summarize https://nextjs.org/docs/app/guides/upgrading/version-16"
- "Use SiteMap to list migration pages on https://nextjs.org/docs"

## Who this is for

This package is especially useful if you:
- migrate shared skills from Claude Code or Codex
- use compound-engineering sync patterns
- want a stable capability contract instead of provider-specific tool names
- maintain a multi-harness agent setup

## Development

```bash
pnpm install
pnpm typecheck
pi -e .
```

## License

MIT
