# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

### Added

- `cachedClient(client, options)` caches `create`, `parse`, `generateContent`, `generateContentStream` and `embedContent` calls on OpenAI, Anthropic and Gemini SDK clients.
- Streamed responses are recorded chunk by chunk and replayed in order. Streams the caller stops reading early are not saved.
- Modes `read-write`, `read-only`, `replay`, `refresh` and `off`, set in code or with `LLM_MEMO`.
- `CacheMissError` in replay mode, so CI fails loudly instead of calling the API.
- `createCache()` with `wrap()`, `call()`, `key()`, `stats()` and `clear()` for caching any async function.
- Disk store (one readable JSON file per call, atomic writes) and in-memory LRU store; custom stores supported.
- Options: `ttl`, `namespace`, `ignoreKeys`, `storeRequest`, `methods`, `keyAllArgs`, `revive`.
- Overlapping identical calls share one request.

[0.1.0]: https://github.com/acus9345/llm-memo/releases/tag/v0.1.0
