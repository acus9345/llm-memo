import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  CacheMissError,
  cachedClient,
  createCache,
  diskStore,
  memoryStore,
  parseTtl,
  stableStringify,
  type CacheMode,
} from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "llm-memo-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirCount = 0;
const freshDir = () => join(root, `cache-${dirCount++}`);

// A fake SDK shaped like the real ones: class-based resources, private fields, getters.
class Completions {
  #client: FakeClient;
  constructor(client: FakeClient) {
    this.#client = client;
  }
  async create(params: { model: string; messages: { content: string }[]; stream?: boolean }, _opts?: unknown) {
    this.#client.calls++;
    const text = `echo: ${params.messages.at(-1)?.content} #${this.#client.calls}`;
    if (params.stream) {
      return (async function* () {
        for (const word of text.split(" ")) yield { delta: word };
      })();
    }
    return { id: `cmpl_${this.#client.calls}`, model: params.model, text };
  }
}
class FakeClient {
  calls = 0;
  #apiKey = "sk-test";
  chat = { completions: new Completions(this) };
  get keyPrefix() {
    return this.#apiKey.slice(0, 3);
  }
  models() {
    return ["m1", "m2"];
  }
}

const params = (content: string, extra: object = {}) => ({ model: "m", messages: [{ content }], ...extra });

describe("cachedClient", () => {
  it("records on the first call and replays after that", async () => {
    const raw = new FakeClient();
    const client = cachedClient(raw, { dir: freshDir() });
    const a = await client.chat.completions.create(params("hi"));
    const b = await client.chat.completions.create(params("hi"));
    const c = await client.chat.completions.create(params("other"));
    assert.equal(raw.calls, 2);
    assert.deepEqual(a, b);
    assert.equal((c as { text: string }).text, "echo: other #2");
  });

  it("ignores key order and request options", async () => {
    const raw = new FakeClient();
    const client = cachedClient(raw, { store: "memory" });
    await client.chat.completions.create({ model: "m", messages: [{ content: "x" }] }, { timeout: 1 });
    await client.chat.completions.create({ messages: [{ content: "x" }], model: "m" }, { timeout: 2 });
    assert.equal(raw.calls, 1);
  });

  it("passes other properties, getters and methods through", () => {
    const client = cachedClient(new FakeClient(), { store: "memory" });
    assert.equal(client.keyPrefix, "sk-");
    assert.deepEqual(client.models(), ["m1", "m2"]);
    assert.equal(client.chat, client.chat); // stable proxies
  });

  it("records streams chunk by chunk and replays them", async () => {
    const raw = new FakeClient();
    const client = cachedClient(raw, { store: "memory" });
    const collect = async (s: AsyncIterable<{ delta: string }>) => {
      const out: string[] = [];
      for await (const c of s) out.push(c.delta);
      return out.join(" ");
    };
    const first = await collect((await client.chat.completions.create(params("s", { stream: true }))) as never);
    const second = await collect((await client.chat.completions.create(params("s", { stream: true }))) as never);
    assert.equal(first, "echo: s #1");
    assert.equal(second, first);
    assert.equal(raw.calls, 1);
  });

  it("does not save a stream the caller stopped reading", async () => {
    const raw = new FakeClient();
    const client = cachedClient(raw, { store: "memory" });
    for await (const _ of (await client.chat.completions.create(params("p", { stream: true }))) as AsyncIterable<unknown>) break;
    for await (const _ of (await client.chat.completions.create(params("p", { stream: true }))) as AsyncIterable<unknown>) break;
    assert.equal(raw.calls, 2);
  });

  it("shares one call between overlapping identical requests", async () => {
    const raw = new FakeClient();
    const client = cachedClient(raw, { store: "memory" });
    const results = await Promise.all([1, 2, 3].map(() => client.chat.completions.create(params("same"))));
    assert.equal(raw.calls, 1);
    assert.deepEqual(results[0], results[2]);
  });

  it("can revive responses into class instances", async () => {
    class Response {
      text = "";
      get upper() {
        return this.text.toUpperCase();
      }
    }
    const client = cachedClient(new FakeClient(), {
      store: "memory",
      revive: (r) => Object.assign(new Response(), r),
    });
    await client.chat.completions.create(params("r"));
    const replayed = (await client.chat.completions.create(params("r"))) as unknown as Response;
    assert.equal(replayed.upper, "ECHO: R #1");
  });
});

describe("modes", () => {
  async function run(mode: CacheMode, dir: string) {
    const raw = new FakeClient();
    const client = cachedClient(raw, { dir, mode });
    await client.chat.completions.create(params("m"));
    return raw.calls;
  }

  it("read-only, refresh, off and replay", async () => {
    const dir = freshDir();
    assert.equal(await run("read-only", dir), 1);
    assert.equal(existsSync(dir), false, "read-only writes nothing");
    await assert.rejects(run("replay", dir), (e: unknown) => e instanceof CacheMissError && /replay mode/.test(e.message));
    assert.equal(await run("read-write", dir), 1);
    assert.equal(await run("replay", dir), 0);
    assert.equal(await run("read-only", dir), 0);
    assert.equal(await run("refresh", dir), 1);
    assert.equal(await run("off", dir), 1);
  });

  it("reads the mode from LLM_MEMO", () => {
    process.env.LLM_MEMO = "replay";
    try {
      assert.equal(createCache({ store: "memory" }).mode, "replay");
      process.env.LLM_MEMO = "0";
      assert.equal(createCache({ store: "memory" }).mode, "off");
      process.env.LLM_MEMO = "nope";
      assert.throws(() => createCache({ store: "memory" }), /LLM_MEMO="nope" is not a mode/);
    } finally {
      delete process.env.LLM_MEMO;
    }
  });
});

describe("createCache", () => {
  it("wrap() caches any async function", async () => {
    let calls = 0;
    const cache = createCache({ store: memoryStore() });
    const embed = cache.wrap(async (text: string, _opts?: { signal?: AbortSignal }) => {
      calls++;
      return [text.length, 0.5];
    });
    assert.deepEqual(await embed("hello", { signal: new AbortController().signal }), [5, 0.5]);
    assert.deepEqual(await embed("hello", { signal: new AbortController().signal }), [5, 0.5]);
    assert.equal(calls, 1);
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1, writes: 1 });
  });

  it("expires entries after the ttl", async () => {
    const cache = createCache({ store: "memory", ttl: 20 });
    let calls = 0;
    const fn = () => ++calls;
    await cache.call("q", fn);
    await cache.call("q", fn);
    await new Promise((r) => setTimeout(r, 40));
    await cache.call("q", fn);
    assert.equal(calls, 2);
  });

  it("leaves ignoreKeys out of the hash", () => {
    const cache = createCache({ store: "memory", ignoreKeys: ["user"] });
    assert.equal(cache.key({ model: "m", user: "a" }), cache.key({ model: "m", user: "b" }));
    assert.notEqual(cache.key({ model: "m" }), createCache({ store: "memory", namespace: "x" }).key({ model: "m" }));
  });

  it("writes readable files to disk and survives corrupt ones", async () => {
    const dir = freshDir();
    const cache = createCache({ dir });
    await cache.call({ prompt: "p" }, () => ({ answer: 42 }));
    const sub = readdirSync(dir)[0]!;
    const file = join(dir, sub, readdirSync(join(dir, sub))[0]!);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(entry.request, { prompt: "p" });
    assert.deepEqual(entry.response, { answer: 42 });
    assert.match(entry.createdAt, /^\d{4}-\d\d-\d\dT/);

    writeFileSync(file, "{ truncated");
    let calls = 0;
    assert.deepEqual(await createCache({ dir }).call({ prompt: "p" }, () => (calls++, { answer: 43 })), { answer: 43 });
    assert.equal(calls, 1);

    // Valid JSON that is not a valid entry (missing response/chunks) is also treated as a miss.
    writeFileSync(file, "{}");
    assert.deepEqual(await createCache({ dir }).call({ prompt: "p" }, () => (calls++, { answer: 44 })), { answer: 44 });
    assert.equal(calls, 2);

    await cache.clear();
    assert.equal(existsSync(dir), false);
  });

  it("ignores empty or whitespace LLM_MEMO_DIR", async () => {
    const prevDir = process.env.LLM_MEMO_DIR;
    const prevCwd = process.cwd();
    const workDir = freshDir();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workDir, { recursive: true });
    process.chdir(workDir);
    process.env.LLM_MEMO_DIR = "   ";
    try {
      const store = diskStore();
      const key = "a".repeat(64);
      await store.set(key, { key, createdAt: new Date().toISOString(), response: 1 });
      assert.equal(existsSync(join(workDir, ".llm-cache", "aa", `${key}.json`)), true);
      await store.clear();
      assert.equal(existsSync(workDir), true);
      assert.equal(existsSync(join(workDir, ".llm-cache")), false);
    } finally {
      process.chdir(prevCwd);
      if (prevDir === undefined) delete process.env.LLM_MEMO_DIR;
      else process.env.LLM_MEMO_DIR = prevDir;
    }
  });

  it("storeRequest: false keeps prompts out of the cache files", async () => {
    const cache = createCache({ store: memoryStore(), storeRequest: false });
    await cache.call({ secret: "prompt" }, () => 1);
    const entry = await cache.store.get(cache.key({ secret: "prompt" }));
    assert.equal(entry?.request, undefined);
    assert.equal(entry?.response, 1);
  });

  it("handles ignoreKeys named 'request' or 'ns' without colliding", () => {
    const a = createCache({ store: "memory", namespace: "ns1", ignoreKeys: ["request", "ns"] });
    const b = createCache({ store: "memory", namespace: "ns2", ignoreKeys: ["request", "ns"] });
    assert.notEqual(a.key({ prompt: "one", request: "r1" }), a.key({ prompt: "two", request: "r2" }));
    assert.notEqual(a.key({ prompt: "one" }), b.key({ prompt: "one" }));
  });

  it("handles circular requests when writing to cache", async () => {
    const cache = createCache({ store: memoryStore() });
    const req: Record<string, unknown> = { prompt: "hello" };
    req.self = req;
    let calls = 0;
    assert.equal(await cache.call(req, () => ++calls), 1);
    assert.equal(await cache.call(req, () => ++calls), 1);
    const stored = await cache.store.get(cache.key(req));
    assert.deepEqual(stored?.request, { prompt: "hello", self: "[Circular]" });
  });

  it("treats ttl: 0 and invalid createdAt as expired", async () => {
    const store = memoryStore();
    const zeroCache = createCache({ store, ttl: 0 });
    let calls = 0;
    await zeroCache.call("k", () => ++calls);
    await zeroCache.call("k", () => ++calls);
    assert.equal(calls, 2);

    const ttlCache = createCache({ store, ttl: "1h" });
    const key = ttlCache.key("bad-date");
    await store.set(key, { key, createdAt: "not-a-date", response: "stale" });
    assert.equal(await ttlCache.call("bad-date", () => "fresh"), "fresh");
  });

  it("handles concurrent diskStore reads and writes to the same key", async () => {
    const store = diskStore({ dir: freshDir() });
    const key = "b".repeat(64);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0 ? store.set(key, { key, createdAt: new Date().toISOString(), response: i }) : store.get(key),
      ),
    );
    const final = await store.get(key);
    assert.equal(typeof final?.response, "number");
  });

  it("does not leak map index into stream revive callback", async () => {
    const client = cachedClient(new FakeClient(), {
      store: "memory",
      revive: (chunk, ...rest: unknown[]) => {
        assert.equal(rest.length, 0);
        return chunk;
      },
    });
    for await (const _ of (await client.chat.completions.create(params("rev", { stream: true }))) as AsyncIterable<unknown>) {
      // record
    }
    for await (const _ of (await client.chat.completions.create(params("rev", { stream: true }))) as AsyncIterable<unknown>) {
      // replay
    }
  });
});

describe("helpers", () => {
  it("parseTtl", () => {
    assert.equal(parseTtl("90s"), 90_000);
    assert.equal(parseTtl("1.5h"), 5_400_000);
    assert.equal(parseTtl("7d"), 604_800_000);
    assert.equal(parseTtl(5), 5);
    assert.throws(() => parseTtl("soon"), /can't read ttl "soon"/);
  });

  it("stableStringify", () => {
    assert.equal(stableStringify({ b: 1, a: [undefined, 2], c: undefined }), '{"a":[null,2],"b":1}');
    const circular: Record<string, unknown> = { x: 1 };
    circular.self = circular;
    assert.equal(stableStringify(circular), '{"self":"[Circular]","x":1}');
    assert.equal(
      stableStringify({ d: new Date(0), bad: new Date("invalid"), n: 10n, s: new AbortController().signal }),
      '{"bad":"Invalid Date","d":"1970-01-01T00:00:00.000Z","n":"10n","s":"[AbortSignal]"}',
    );
    assert.equal(stableStringify(JSON.parse('{"__proto__":{"a":1},"b":2}')), '{"__proto__":{"a":1},"b":2}');
    assert.equal(stableStringify(runInNewContext("({ b: 1, a: 2 })")), '{"a":2,"b":1}');
  });
});
