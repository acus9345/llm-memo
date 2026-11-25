import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "response" in value || Array.isArray((value as Entry).chunks);
}

/** One cached call. */
export interface Entry {
  /** The cache key (sha256 hex). */
  key: string;
  /** ISO timestamp of when the response was recorded. */
  createdAt: string;
  /** What was hashed to make the key, kept for debugging. Omitted with `storeRequest: false`. */
  request?: unknown;
  /** The JSON-serialized response. */
  response?: unknown;
  /** For streamed responses: every chunk in order. */
  chunks?: unknown[];
}

/** Where entries live. Implement this to cache in Redis, SQLite or anything else. */
export interface Store {
  get(key: string): Promise<Entry | undefined>;
  set(key: string, entry: Entry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface MemoryStoreOptions {
  /** Drop the least recently used entries beyond this count. Default: unlimited. */
  maxEntries?: number;
}

/** Keep entries in a `Map` for the life of the process. */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const map = new Map<string, Entry>();
  const max = options.maxEntries ?? Infinity;
  return {
    async get(key) {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      // Re-insert to mark as recently used.
      map.delete(key);
      map.set(key, entry);
      return structuredClone(entry);
    },
    async set(key, entry) {
      map.delete(key);
      map.set(key, structuredClone(entry));
      while (map.size > max) map.delete(map.keys().next().value!);
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

export interface DiskStoreOptions {
  /** Folder for cache files. Default: `$LLM_MEMO_DIR` or `.llm-cache` in the current directory. */
  dir?: string;
}

/**
 * One pretty-printed JSON file per entry, in `<dir>/<first 2 chars of key>/<key>.json`.
 * Commit the folder to replay recorded responses in CI without API keys.
 */
export function diskStore(options: DiskStoreOptions = {}): Store {
  const rawDir = options.dir?.trim() ? options.dir : process.env.LLM_MEMO_DIR?.trim() ? process.env.LLM_MEMO_DIR : ".llm-cache";
  const dir = resolve(rawDir);
  const pathFor = (key: string) => join(dir, key.slice(0, 2), `${key}.json`);
  return {
    async get(key) {
      let text: string;
      try {
        text = await readFile(pathFor(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!isEntry(parsed)) return undefined;
        return parsed;
      } catch {
        // A truncated or hand-edited file is treated as a miss and rewritten.
        return undefined;
      }
    },
    async set(key, entry) {
      const path = pathFor(key);
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
      // Write then rename so readers never see a half-written file.
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`);
      try {
        // Windows can return transient EPERM/EACCES/EBUSY when concurrent readers/writers race on rename.
        for (let attempt = 0; ; attempt++) {
          try {
            await rename(tmp, path);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !RETRYABLE_RENAME.has(code) || attempt >= 5) throw error;
            await sleep(10 * 2 ** attempt);
          }
        }
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async clear() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
