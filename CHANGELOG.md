# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-03-10

### Added
- Initial public release of `@startupbros/pi-research-fabric`
- Harness-agnostic capability tools for Pi:
  - `WebSearch`
  - `WebFetch`
  - `CodeContextSearch`
  - `SiteMap`
- Provider routing across Exa, Firecrawl, and Brave
- Disk-backed caching with configurable TTLs
- Compatibility layer for migrated cross-harness skills and commands
- Config discovery for project-level and global Pi installs
- README, example config, and package metadata

### Fixed
- Exa `deep: true` compatibility by mapping to a supported request shape instead of an unsupported search mode enum
