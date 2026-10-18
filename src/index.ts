/**
 * Cache LLM API calls by request hash so tests and dev loops stop paying for repeat calls.
 *
 * @example
 * import OpenAI from "openai";
 * import { cachedClient } from "llm-memo";
 *
 * const openai = cachedClient(new OpenAI());
 * await openai.chat.completions.create({ model: "gpt-5-mini", messages }); // calls the API
 * await openai.chat.completions.create({ model: "gpt-5-mini", messages }); // instant, from .llm-cache/
 */
import { createHash } from "node:crypto";
import { diskStore, memoryStore, type Entry, type Store } from "./stores.js";

export { diskStore, memoryStore };
export type { DiskStoreOptions, Entry, MemoryStoreOptions, Store } from "./stores.js";

/**
 * - `read-write` (default): return cached responses, call and record on a miss.
 * - `read-only`: return cached responses, call on a miss but don't record.
 * - `replay`: return cached responses, throw {@link CacheMissError} on a miss. Use in CI without API keys.
 * - `refresh`: always call and overwrite the cache.
 * - `off`: always call, never read or write.
 */
export type CacheMode = "read-write" | "read-only" | "replay" | "refresh" | "off";

const MODES: readonly CacheMode[] = ["read-write", "read-only", "replay", "refresh", "off"];

export interface CacheOptions {
  /** A store, or `"disk"` (default) / `"memory"`. */
  store?: Store | "disk" | "memory";
  /** Folder for the disk store. Default: `$LLM_MEMO_DIR` or `.llm-cache`. */
  dir?: string;
  /** Default: `$LLM_MEMO` if set, otherwise `"read-write"`. */
  mode?: CacheMode;
  /** Treat entries older than this as missing. Milliseconds or a string like `"12h"` or `"7d"`. Default: never expire. */
  ttl?: number | string;
  /** Mixed into every key, so two caches sharing a store don't collide. */
  namespace?: string;
  /** Property names to leave out of the hash at any depth, e.g. `["user", "metadata"]`. */
  ignoreKeys?: readonly string[];
  /** Save the hashed request next to the response for debugging. Default `true`. */
  storeRequest?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

/** Thrown in `replay` mode when a call has no recorded response. */
export class CacheMissError extends Error {
  readonly key: string;
  readonly request: unknown;
  constructor(key: string, request: unknown) {
    super(
      `llm-memo: no recorded response for this request (key ${key.slice(0, 12)}…) and the cache is in replay mode. ` +
        `Run once with LLM_MEMO=read-write and an API key to record it, then commit the cache folder.`,
    );
    this.name = "CacheMissError";
    this.key = key;
    this.request = request;
  }
}

export interface CallOptions {
  /** Turn the stored JSON back into what callers expect, e.g. a class instance. */
  revive?: (response: unknown) => unknown;
}

export class LLMCache {
  readonly mode: CacheMode;
  readonly store: Store;
  readonly #ttl: number | undefined;
  readonly #namespace: string | undefined;
  readonly #ignore: ReadonlySet<string>;
  readonly #storeRequest: boolean;
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #stats: CacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(options: CacheOptions = {}) {
    this.mode = options.mode ?? modeFromEnv() ?? "read-write";
    if (!MODES.includes(this.mode)) {
      throw new TypeError(`llm-memo: unknown mode "${String(this.mode)}". Use one of: ${MODES.join(", ")}.`);
    }
    const store = options.store ?? "disk";
    this.store =
      store === "disk" ? diskStore(options.dir === undefined ? {} : { dir: options.dir }) : store === "memory" ? memoryStore() : store;
    this.#ttl = options.ttl === undefined ? undefined : parseTtl(options.ttl);
    this.#namespace = options.namespace;
    this.#ignore = new Set(options.ignoreKeys ?? []);
    this.#storeRequest = options.storeRequest ?? true;
  }

  /** The cache key for a request: sha256 of its canonical JSON. Key order doesn't matter. */
  key(request: unknown): string {
    const canonical = stableStringify({ ns: this.#namespace ?? null, request }, this.#ignore);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Return the cached response for `request`, or run `fn`, cache its result and return it.
   * Identical calls that overlap share one underlying call. If `fn` resolves to an async
   * iterable (a stream), its chunks are passed through as they arrive and recorded once it ends.
   */
  async call<T>(request: unknown, fn: () => T | Promise<T>, options: CallOptions = {}): Promise<T> {
    if (this.mode === "off") return fn();
    const key = this.key(request);
    const revive = options.revive ?? ((r: unknown) => r);

    if (this.mode !== "refresh") {
      const entry = await this.#read(key);
      if (entry) {
        this.#stats.hits++;
        return (entry.chunks ? replay(entry.chunks.map(revive)) : revive(entry.response)) as T;
      }
    }
    this.#stats.misses++;
    if (this.mode === "replay") throw new CacheMissError(key, request);

    const pending = this.#inflight.get(key);
    if (pending) {
      const shared = await pending;
      // A stream can only be read once, so an overlapping identical call makes its own.
      if (!isAsyncIterable(shared)) return shared as T;
      return this.#fetch(key, request, fn) as Promise<T>;
    }
    const promise = this.#fetch(key, request, fn);
    this.#inflight.set(key, promise);
    try {
      return (await promise) as T;
    } finally {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
    }
  }

  async #fetch(key: string, request: unknown, fn: () => unknown): Promise<unknown> {
    const result = await fn();
    if (isAsyncIterable(result)) return this.#record(key, request, result);
    if (this.mode !== "read-only") await this.#write(key, request, { response: toJson(result) });
    return result;
  }

  /**
   * Wrap an async function so calls with the same arguments are cached.
   * By default every argument is part of the key; pass `key` to choose what is.
   */
  wrap<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    options: CallOptions & { key?: (...args: A) => unknown; name?: string } = {},
  ): (...args: A) => Promise<R> {
    const name = options.name ?? (fn.name || "anonymous");
    return (...args: A) =>
      this.call({ fn: name, args: options.key ? options.key(...args) : args }, () => fn(...args), options);
  }

  /** Hit, miss and write counts since the cache was created. */
  stats(): CacheStats {
    return { ...this.#stats };
  }

  /** Delete every entry in the store. */
  async clear(): Promise<void> {
    await this.store.clear();
  }

  async #read(key: string): Promise<Entry | undefined> {
    const entry = await this.store.get(key);
    if (!entry) return undefined;
    if (this.#ttl !== undefined && Date.now() - Date.parse(entry.createdAt) > this.#ttl) return undefined;
    return entry;
  }

  async #write(key: string, request: unknown, data: Pick<Entry, "response" | "chunks">): Promise<void> {
    const entry: Entry = { key, createdAt: new Date().toISOString() };
    if (this.#storeRequest) entry.request = toJson(request);
    Object.assign(entry, data);
    await this.store.set(key, entry);
    this.#stats.writes++;
  }

  async *#record(key: string, request: unknown, stream: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(toJson(chunk));
      yield chunk;
    }
    // Only complete streams are saved; a caller that breaks out early records nothing.
    if (this.mode !== "read-only") await this.#write(key, request, { chunks });
  }
}

/** Create a cache. See {@link CacheOptions}. */
export function createCache(options: CacheOptions = {}): LLMCache {
  return new LLMCache(options);
}

export interface CachedClientOptions extends CacheOptions, CallOptions {
  /** Use this cache instead of creating one from the other options. */
  cache?: LLMCache;
  /**
   * Method names to cache, anywhere in the client. Default: `create` (OpenAI and Anthropic),
   * `parse` (OpenAI structured outputs), `generateContent` and `generateContentStream` (Gemini)
   * and `embedContent`. Other methods pass through untouched.
   */
  methods?: readonly string[];
  /** Include the second and later arguments (request options like headers and timeouts) in the key. Default `false`. */
  keyAllArgs?: boolean;
}

const DEFAULT_METHODS = ["create", "parse", "generateContent", "generateContentStream", "embedContent"];

/**
 * Return a client that caches calls to its model methods (`client.chat.completions.create`,
 * `client.messages.create`, `ai.models.generateContent` and so on). Everything else passes through.
 */
export function cachedClient<T extends object>(client: T, options: CachedClientOptions = {}): T {
  const cache = options.cache ?? createCache(options);
  const methods = new Set(options.methods ?? DEFAULT_METHODS);
  const proxies = new WeakMap<object, object>();

  const wrapObject = (target: object, path: string): object => {
    const existing = proxies.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(t, prop) {
        // Use the real object as receiver so getters that touch private fields keep working.
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof prop === "symbol" || value === null || (typeof value !== "object" && typeof value !== "function")) {
          return value;
        }
        const desc = Object.getOwnPropertyDescriptor(t, prop);
        if (desc && !desc.configurable && !desc.writable && "value" in desc) return value; // proxy invariant
        const childPath = path ? `${path}.${prop}` : prop;
        if (typeof value === "function") {
          if (!methods.has(prop)) return (value as (...a: unknown[]) => unknown).bind(t);
          const fn = value as (...a: unknown[]) => unknown;
          return (...args: unknown[]) =>
            cache.call(
              { method: childPath, args: options.keyAllArgs ? args : args.slice(0, 1) },
              () => fn.apply(t, args),
              options,
            );
        }
        if (value instanceof Promise || ArrayBuffer.isView(value)) return value;
        return wrapObject(value as object, childPath);
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return wrapObject(client, "") as T;
}

// --- helpers -----------------------------------------------------------------

function modeFromEnv(): CacheMode | undefined {
  const value = process.env.LLM_MEMO?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "0" || value === "false") return "off";
  if (value === "1" || value === "true" || value === "on") return "read-write";
  if ((MODES as readonly string[]).includes(value)) return value as CacheMode;
  throw new TypeError(`llm-memo: LLM_MEMO="${value}" is not a mode. Use one of: ${MODES.join(", ")}.`);
}

const TTL_UNITS: Record<string, number> = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };

/** Parse `"90s"`, `"15m"`, `"12h"`, `"7d"`, `"2w"` or a number of milliseconds. */
export function parseTtl(ttl: number | string): number {
  if (typeof ttl === "number") {
    if (!Number.isFinite(ttl) || ttl < 0) throw new TypeError(`llm-memo: ttl must be a positive number of milliseconds.`);
    return ttl;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(ttl);
  if (!m) throw new TypeError(`llm-memo: can't read ttl "${ttl}". Use milliseconds or a string like "30m", "12h" or "7d".`);
  return Number(m[1]) * TTL_UNITS[m[2]!.toLowerCase()]!;
}

/**
 * Canonical JSON: object keys sorted, `undefined` and functions dropped, class instances
 * other than Date reduced to their `toJSON()` or their class name (an `AbortSignal` doesn't change the key).
 */
export function stableStringify(value: unknown, ignore: ReadonlySet<string> = new Set()): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x) ?? null);
      if (v instanceof Date) return v.toISOString();
      if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
      const proto = Object.getPrototypeOf(v) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        const toJSON = (v as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") return walk(toJSON.call(v));
        if (v instanceof Map) return walk(Object.fromEntries(v));
        if (v instanceof Set) return walk([...v]);
        return `[${proto.constructor?.name ?? "Object"}]`;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        if (ignore.has(k)) continue;
        const w = walk((v as Record<string, unknown>)[k]);
        if (w !== undefined) out[k] = w;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return JSON.stringify(walk(value)) ?? "null";
}

function toJson(value: unknown): unknown {
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return text === undefined ? null : JSON.parse(text);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function* replay(chunks: readonly unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}
