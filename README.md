# llm-memo

Cache LLM API calls by request hash, on disk or in memory, so tests and dev loops stop paying for repeat calls. Zero dependencies.

[![npm](https://img.shields.io/npm/v/llm-memo)](https://www.npmjs.com/package/llm-memo)
[![CI](https://github.com/acus9345/llm-memo/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/llm-memo/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/llm-memo)](LICENSE)

- **One line:** wrap your OpenAI, Anthropic or Gemini client and keep using it as before.
- **Streams too:** `stream: true` responses are recorded chunk by chunk and replayed in order.
- **Replay in CI:** commit the cache folder, set `LLM_MEMO=replay`, and tests run without API keys. A missing recording fails loudly instead of calling the API.
- **Readable files:** one pretty-printed JSON file per call, with the request next to the response.
- Key order doesn't matter, overlapping identical calls share one request, entries can expire, and any async function can be cached.

## Install

```bash
npm install --save-dev llm-memo
```

## Quick start

```js
import OpenAI from "openai";
import { cachedClient } from "llm-memo";

const openai = cachedClient(new OpenAI());

const ask = () =>
  openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "Name a prime number." }],
  });

await ask(); // calls the API and saves the response in .llm-cache/
await ask(); // same request: read from .llm-cache/ in about a millisecond, no API call
```

The same works for the other SDKs:

```js
const anthropic = cachedClient(new Anthropic());
await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 200, messages });

const ai = cachedClient(new GoogleGenAI({}));
await ai.models.generateContent({ model: "gemini-2.5-flash", contents: "Hello" });
```

`create`, `parse`, `generateContent`, `generateContentStream` and `embedContent` are cached wherever they appear in the client. Everything else passes through untouched. Only the first argument (the request body) is hashed, so headers, timeouts and abort signals don't change the key.

## Modes

Set the mode in code (`{ mode: "replay" }`) or with the `LLM_MEMO` environment variable:

| Mode | On a cache hit | On a miss |
| --- | --- | --- |
| `read-write` (default) | return it | call the API and save the response |
| `read-only` | return it | call the API, don't save |
| `replay` | return it | throw `CacheMissError`, no API call |
| `refresh` | call the API and overwrite | call the API and save |
| `off` | call the API | call the API |

A typical setup records locally and replays in CI:

```bash
# once, locally, with an API key
npm test
git add .llm-cache && git commit -m "Record LLM fixtures"
```

```yaml
# CI: no API key needed
- run: npm test
  env:
    LLM_MEMO: replay
```

When a prompt changes, its hash changes, so the test fails in CI with `CacheMissError` until you record it again. `LLM_MEMO=refresh npm test` re-records everything.

## API

### `cachedClient(client, options?)`

Returns a proxy of `client` that caches model calls. Options (all optional):

| Option | Default | What it does |
| --- | --- | --- |
| `store` | `"disk"` | `"disk"`, `"memory"` or your own store (see below). |
| `dir` | `$LLM_MEMO_DIR` or `.llm-cache` | Folder for the disk store. |
| `mode` | `$LLM_MEMO` or `"read-write"` | See [Modes](#modes). |
| `ttl` | none | Treat older entries as missing: milliseconds or `"30m"`, `"12h"`, `"7d"`. |
| `namespace` | none | Mixed into every key so two caches can share a folder. |
| `ignoreKeys` | `[]` | Property names left out of the hash at any depth, e.g. `["user", "metadata"]`. |
| `storeRequest` | `true` | Save the request next to the response. Set `false` if prompts contain secrets. |
| `methods` | see above | Method names to cache. |
| `keyAllArgs` | `false` | Also hash the second and later arguments. |
| `revive` | none | Turn stored JSON back into what your code expects (see below). |
| `cache` | none | Use an existing `LLMCache` instead of creating one. |

Cached responses come back as plain JSON. That's what the OpenAI and Anthropic SDKs return anyway. Gemini's response class has getters like `.text`, so restore it with `revive`:

```js
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

const ai = cachedClient(new GoogleGenAI({}), {
  revive: (r) => Object.assign(new GenerateContentResponse(), r),
});
```

For streams, `revive` runs on each chunk. Replayed streams are plain async iterables: `for await` works, but SDK helpers on the stream object (like `controller.abort()`) don't exist on a replay.

### `createCache(options?)`

Creates an `LLMCache` with the same options as above, for code that doesn't go through an SDK client.

- `cache.wrap(fn, { key?, name?, revive? })` returns a cached version of an async function. Every argument is hashed unless you pass `key: (...args) => whatToHash`.
- `cache.call(request, fn)` returns the cached response for `request` or runs `fn` and saves its result.
- `cache.key(request)` returns the sha256 key for a request.
- `cache.stats()` returns `{ hits, misses, writes }`.
- `cache.clear()` deletes every entry.

```js
import { createCache } from "llm-memo";

const cache = createCache({ ttl: "1d" });
const embed = cache.wrap(async (text) => {
  const res = await fetch("https://api.example.com/embed", { method: "POST", body: text });
  return res.json();
});
```

### Stores

`diskStore({ dir })` and `memoryStore({ maxEntries })` are exported. Any object with async `get(key)`, `set(key, entry)`, `delete(key)` and `clear()` works as a store, for example one backed by Redis or SQLite.

On disk, entries live in `<dir>/<first two characters of the key>/<key>.json`:

```json
{
  "key": "4be1e0c1...",
  "createdAt": "2026-10-18T09:30:00.000Z",
  "request": { "method": "chat.completions.create", "args": [{ "model": "gpt-5-mini", "messages": [...] }] },
  "response": { "id": "chatcmpl-...", "choices": [...] }
}
```

## Good to know

- Keys come from the request only, so the same prompt sent with different API keys or to a different base URL shares an entry. Use `namespace` to separate them.
- Errors are never cached. A failed call is retried next time.
- A stream is saved only once it has been read to the end.
- Add `.llm-cache/` to `.gitignore` if you don't want to commit recordings.

## License

MIT
