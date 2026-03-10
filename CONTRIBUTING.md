# Contributing

Thanks for contributing to `pi-research-fabric`.

## Development

```bash
pnpm install
pnpm typecheck
```

To try the package locally in Pi:

```bash
pi -e .
```

## Project goals

This package should stay:
- cross-harness friendly
- Pi-native in packaging and install flow
- conservative about provider assumptions
- easy to adopt for migrated skills and prompts

## Scope

Good contributions include:
- new provider integrations behind existing capability tools
- better fallback behavior
- clearer docs and examples
- test and CI improvements
- compatibility fixes for migrated skill ecosystems

Please avoid introducing provider-specific abstractions into the public capability surface unless they clearly improve multi-harness compatibility.
