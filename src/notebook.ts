/**
 * The Research Notebook store.
 *
 * A `Notebook` owns one JSON document on disk (`notebook.json`) inside a
 * directory the researcher chooses (their project, by default). It provides the
 * create / read / update / delete and search operations the MCP tools expose.
 *
 * Everything that touches the outside world - the filesystem, the clock, id
 * generation - is injected, so the whole class runs deterministically against a
 * temp directory in tests.
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  type NotebookData,
  type Note,
  type Quote,
  type Source,
  type SourceType,
  SOURCE_TYPES,
  emptyNotebook,
} from "./types.js";
import { uniqueCiteKey } from "./citekey.js";

export interface NotebookDeps {
  /** Directory that holds `notebook.json` and generated exports. */
  dir: string;
  /** Clock, injectable for deterministic timestamps in tests. */
  now?: () => Date;
  /** Random suffix generator for ids, injectable for tests. */
  makeId?: () => string;
}

export const NOTEBOOK_FILENAME = "notebook.json";

/** How long to wait to acquire the write lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;
/** Poll interval while waiting for a held lock. */
const LOCK_RETRY_MS = 25;
/** A lock older than this is assumed abandoned by a crashed writer and stolen. */
const LOCK_STALE_MS = 30_000;

export interface AddSourceInput {
  title: string;
  type?: SourceType;
  url?: string;
  authors?: string[];
  container?: string;
  publishedDate?: string;
  doi?: string;
  tags?: string[];
  summary?: string;
}

export interface RemoveSourceResult {
  removed: Source;
  /** Notes that still referenced the removed source (link was dropped). */
  affectedNotes: string[];
}

export class NotebookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookError";
  }
}

/** A persist was refused because notebook.json changed on disk since it loaded. */
export class NotebookConflictError extends NotebookError {
  constructor(message: string) {
    super(message);
    this.name = "NotebookConflictError";
  }
}

/** Normalise a URL for de-duplication: drop fragment, tracking params, trailing slash. */
export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    const drop = [...u.searchParams.keys()].filter(
      (k) => k.startsWith("utm_") || k === "fbclid" || k === "gclid" || k === "ref",
    );
    for (const k of drop) u.searchParams.delete(k);
    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
    return out;
  } catch {
    return url.trim();
  }
}

/** Identifies the exact on-disk file we last read or wrote, for conflict detection. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

export class Notebook {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private data: NotebookData;
  /**
   * The stamp of notebook.json as we last saw it (null when the file did not
   * exist). Any change to this on disk before a persist means another editor
   * or a second server wrote it, and we must not clobber that blindly.
   */
  private stamp: FileStamp | null;

  private constructor(deps: NotebookDeps, data: NotebookData, stamp: FileStamp | null) {
    this.dir = deps.dir;
    this.now = deps.now ?? (() => new Date());
    this.makeId = deps.makeId ?? (() => randomBytes(4).toString("hex"));
    this.data = data;
    this.stamp = stamp;
  }

  get filePath(): string {
    return path.join(this.dir, NOTEBOOK_FILENAME);
  }

  get directory(): string {
    return this.dir;
  }

  /** Load the notebook from disk, creating an empty one if none exists. */
  static async open(deps: NotebookDeps): Promise<Notebook> {
    await fs.mkdir(deps.dir, { recursive: true });
    const filePath = path.join(deps.dir, NOTEBOOK_FILENAME);
    const { data, stamp } = await Notebook.readFrom(filePath);
    return new Notebook(deps, data, stamp);
  }

  /** Read and migrate notebook.json, returning its data and on-disk stamp. */
  private static async readFrom(
    filePath: string,
  ): Promise<{ data: NotebookData; stamp: FileStamp | null }> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const info = await fs.stat(filePath);
      return {
        data: migrate(JSON.parse(raw)),
        stamp: { mtimeMs: info.mtimeMs, size: info.size },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { data: emptyNotebook(), stamp: null };
      }
      if (err instanceof SyntaxError) {
        throw new NotebookError(
          `notebook.json at ${filePath} is not valid JSON. Fix or remove it before continuing.`,
        );
      }
      throw err;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async currentStamp(): Promise<FileStamp | null> {
    try {
      const info = await fs.stat(this.filePath);
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private static sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
    if (a === null || b === null) return a === b;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  /**
   * Write the whole in-memory document back, serialized against concurrent
   * writers and guarded against silently overwriting an external edit.
   *
   * - An exclusive lock file (O_EXCL) serializes writers in this and any other
   *   process sharing the directory, so the read-stamp / write / rename
   *   sequence below cannot interleave with another writer's.
   * - While holding the lock, if the file's stamp differs from the one we
   *   loaded, someone changed it underneath us. We reload the on-disk version
   *   (dropping the rejected mutation so memory is never left poisoned) and
   *   throw, asking the caller to re-apply their change.
   * - The temp file is unique per process and attempt, so two writers never
   *   stream into the same scratch path.
   */
  private async persist(): Promise<void> {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.acquireLock();

      const onDisk = await this.currentStamp();
      if (!Notebook.sameStamp(onDisk, this.stamp)) {
        // External write since we loaded: reload the truth and refuse, so we
        // neither clobber that edit nor keep the rejected mutation in memory.
        await this.reloadLocked();
        throw new NotebookConflictError(
          "notebook.json changed on disk since it was loaded (another editor or a " +
            "second notebook server). Reloaded the on-disk version; re-apply your change.",
        );
      }

      const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
        await fs.rename(tmp, this.filePath); // atomic replace
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      this.stamp = await this.currentStamp();
    } catch (err) {
      // The caller mutated `this.data` before calling persist, so on any failure
      // we restore consistency from the untouched on-disk bytes rather than a
      // stale snapshot: a refused write must never leave memory poisoned. (The
      // conflict path above already reloaded; reloading again is idempotent.)
      if (!(err instanceof NotebookConflictError)) {
        await this.reloadLocked().catch(() => {
          /* disk unreadable: keep current state and surface the original error */
        });
      }
      throw err;
    } finally {
      if (release) await release();
    }
  }

  /** Replace in-memory data and stamp from disk. Caller must hold the lock. */
  private async reloadLocked(): Promise<void> {
    const reloaded = await Notebook.readFrom(this.filePath);
    this.data = reloaded.data;
    this.stamp = reloaded.stamp;
  }

  /** Acquire an advisory lock on the notebook; returns a release function. */
  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Steal a lock left behind by a crashed writer.
        const age = await this.lockAge(lockPath);
        if (age !== null && age > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw new NotebookError(
            "could not acquire the notebook lock; another write is in progress. Try again.",
          );
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }

  private async lockAge(lockPath: string): Promise<number | null> {
    try {
      const info = await fs.stat(lockPath);
      return Date.now() - info.mtimeMs;
    } catch {
      return null; // vanished between open and stat; loop will retry
    }
  }

  /** Write an arbitrary export file next to the notebook and return its path. */
  async writeExport(filename: string, contents: string): Promise<string> {
    const target = path.join(this.dir, filename);
    await fs.writeFile(target, contents, "utf8");
    return target;
  }

  snapshot(): NotebookData {
    return structuredClone(this.data);
  }

  setTitle(title: string): Promise<void> {
    this.data.title = title;
    return this.persist();
  }

  get title(): string | undefined {
    return this.data.title;
  }

  allCiteKeys(): Set<string> {
    return new Set(this.data.sources.map((s) => s.citeKey));
  }

  // --- Sources -------------------------------------------------------------

  findByUrl(url: string): Source | undefined {
    const key = normaliseUrl(url);
    return this.data.sources.find((s) => s.url && normaliseUrl(s.url) === key);
  }

  resolveSource(idOrKey: string): Source | undefined {
    return this.data.sources.find((s) => s.id === idOrKey || s.citeKey === idOrKey);
  }

  private requireSource(idOrKey: string): Source {
    const src = this.resolveSource(idOrKey);
    if (!src) throw new NotebookError(`No source found with id or cite key "${idOrKey}".`);
    return src;
  }

  async addSource(input: AddSourceInput): Promise<Source> {
    const title = input.title?.trim();
    if (!title) throw new NotebookError("A source needs a non-empty title.");
    const ts = this.timestamp();
    const citeKey = uniqueCiteKey(
      {
        authors: input.authors,
        publishedDate: input.publishedDate,
        title,
        container: input.container,
      },
      this.allCiteKeys(),
    );
    const source: Source = {
      id: `src-${this.makeId()}`,
      citeKey,
      type: input.type ?? "webpage",
      title,
      url: input.url?.trim() || undefined,
      authors: dedupeStrings(input.authors ?? []),
      container: input.container?.trim() || undefined,
      publishedDate: input.publishedDate?.trim() || undefined,
      accessedDate: ts,
      doi: input.doi?.trim() || undefined,
      tags: normaliseTags(input.tags),
      quotes: [],
      summary: input.summary?.trim() || undefined,
      createdAt: ts,
      updatedAt: ts,
    };
    this.data.sources.push(source);
    await this.persist();
    return source;
  }

  async updateSource(
    idOrKey: string,
    patch: Partial<AddSourceInput>,
  ): Promise<Source> {
    const src = this.requireSource(idOrKey);
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new NotebookError("Title cannot be blank.");
      src.title = t;
    }
    if (patch.type !== undefined) src.type = patch.type;
    if (patch.url !== undefined) src.url = patch.url.trim() || undefined;
    if (patch.authors !== undefined) src.authors = dedupeStrings(patch.authors);
    if (patch.container !== undefined) src.container = patch.container.trim() || undefined;
    if (patch.publishedDate !== undefined) src.publishedDate = patch.publishedDate.trim() || undefined;
    if (patch.doi !== undefined) src.doi = patch.doi.trim() || undefined;
    if (patch.tags !== undefined) src.tags = normaliseTags(patch.tags);
    if (patch.summary !== undefined) src.summary = patch.summary.trim() || undefined;
    src.updatedAt = this.timestamp();
    await this.persist();
    return src;
  }

  async addQuote(
    idOrKey: string,
    quote: { text: string; page?: string; note?: string },
  ): Promise<Source> {
    const src = this.requireSource(idOrKey);
    const text = quote.text?.trim();
    if (!text) throw new NotebookError("A quote needs non-empty text.");
    src.quotes.push({
      text,
      page: quote.page?.trim() || undefined,
      note: quote.note?.trim() || undefined,
      addedAt: this.timestamp(),
    });
    src.updatedAt = this.timestamp();
    await this.persist();
    return src;
  }

  async removeSource(idOrKey: string): Promise<RemoveSourceResult> {
    const src = this.requireSource(idOrKey);
    this.data.sources = this.data.sources.filter((s) => s.id !== src.id);
    const affectedNotes: string[] = [];
    for (const note of this.data.notes) {
      if (note.sourceIds.includes(src.id)) {
        note.sourceIds = note.sourceIds.filter((sid) => sid !== src.id);
        note.updatedAt = this.timestamp();
        affectedNotes.push(note.id);
      }
    }
    await this.persist();
    return { removed: src, affectedNotes };
  }

  listSources(filter?: { tag?: string }): Source[] {
    let list = [...this.data.sources];
    if (filter?.tag) {
      const tag = filter.tag.toLowerCase();
      list = list.filter((s) => s.tags.includes(tag));
    }
    return list.sort((a, b) => a.citeKey.localeCompare(b.citeKey));
  }

  // --- Notes ---------------------------------------------------------------

  private validateSourceIds(sourceIds: string[]): string[] {
    const resolved: string[] = [];
    for (const ref of sourceIds) {
      const src = this.resolveSource(ref);
      if (!src) throw new NotebookError(`Cannot link note to unknown source "${ref}".`);
      if (!resolved.includes(src.id)) resolved.push(src.id);
    }
    return resolved;
  }

  resolveNote(id: string): Note | undefined {
    return this.data.notes.find((n) => n.id === id);
  }

  private requireNote(id: string): Note {
    const note = this.resolveNote(id);
    if (!note) throw new NotebookError(`No note found with id "${id}".`);
    return note;
  }

  async addNote(input: {
    title: string;
    content: string;
    sourceIds?: string[];
    tags?: string[];
  }): Promise<Note> {
    const title = input.title?.trim();
    if (!title) throw new NotebookError("A note needs a non-empty title.");
    const ts = this.timestamp();
    const note: Note = {
      id: `note-${this.makeId()}`,
      title,
      content: input.content ?? "",
      sourceIds: this.validateSourceIds(input.sourceIds ?? []),
      tags: normaliseTags(input.tags),
      createdAt: ts,
      updatedAt: ts,
    };
    this.data.notes.push(note);
    await this.persist();
    return note;
  }

  async updateNote(
    id: string,
    patch: { title?: string; content?: string; sourceIds?: string[]; tags?: string[] },
  ): Promise<Note> {
    const note = this.requireNote(id);
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new NotebookError("Title cannot be blank.");
      note.title = t;
    }
    if (patch.content !== undefined) note.content = patch.content;
    if (patch.sourceIds !== undefined) note.sourceIds = this.validateSourceIds(patch.sourceIds);
    if (patch.tags !== undefined) note.tags = normaliseTags(patch.tags);
    note.updatedAt = this.timestamp();
    await this.persist();
    return note;
  }

  async removeNote(id: string): Promise<Note> {
    const note = this.requireNote(id);
    this.data.notes = this.data.notes.filter((n) => n.id !== note.id);
    await this.persist();
    return note;
  }

  listNotes(filter?: { tag?: string; sourceId?: string }): Note[] {
    let list = [...this.data.notes];
    if (filter?.tag) {
      const tag = filter.tag.toLowerCase();
      list = list.filter((n) => n.tags.includes(tag));
    }
    if (filter?.sourceId) {
      const src = this.resolveSource(filter.sourceId);
      const id = src?.id ?? filter.sourceId;
      list = list.filter((n) => n.sourceIds.includes(id));
    }
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // --- Search & stats ------------------------------------------------------

  search(query: string): { sources: Source[]; notes: Note[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { sources: [], notes: [] };
    const sources = this.data.sources.filter((s) =>
      [
        s.title,
        s.citeKey,
        s.container ?? "",
        s.summary ?? "",
        s.authors.join(" "),
        s.tags.join(" "),
        s.quotes.map((quote) => `${quote.text} ${quote.note ?? ""}`).join(" "),
      ]
        .join(" \n ")
        .toLowerCase()
        .includes(q),
    );
    const notes = this.data.notes.filter((n) =>
      [n.title, n.content, n.tags.join(" ")].join(" \n ").toLowerCase().includes(q),
    );
    return { sources, notes };
  }

  stats(): {
    sources: number;
    notes: number;
    quotes: number;
    tags: string[];
    byType: Record<string, number>;
  } {
    const tags = new Set<string>();
    const byType: Record<string, number> = {};
    let quotes = 0;
    for (const s of this.data.sources) {
      s.tags.forEach((t) => tags.add(t));
      quotes += s.quotes.length;
      byType[s.type] = (byType[s.type] ?? 0) + 1;
    }
    for (const n of this.data.notes) n.tags.forEach((t) => tags.add(t));
    return {
      sources: this.data.sources.length,
      notes: this.data.notes.length,
      quotes,
      tags: [...tags].sort(),
      byType,
    };
  }
}

function normaliseTags(tags: string[] | undefined): string[] {
  return dedupeStrings((tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Bring an on-disk notebook up to the current schema version. */
function migrate(data: unknown): NotebookData {
  if (!data || typeof data !== "object") return emptyNotebook();
  const obj = data as Partial<NotebookData>;
  const sources: Source[] = [];
  const notes: Note[] = [];
  const dropped: string[] = [];
  (Array.isArray(obj.sources) ? obj.sources : []).forEach((entry, i) => {
    const normalised = normaliseSource(entry);
    if (normalised) sources.push(normalised);
    else dropped.push(`sources[${i}]`);
  });
  (Array.isArray(obj.notes) ? obj.notes : []).forEach((entry, i) => {
    const normalised = normaliseNote(entry);
    if (normalised) notes.push(normalised);
    else dropped.push(`notes[${i}]`);
  });
  // Fail closed, like the corrupt-JSON path: an entry the normaliser cannot
  // read is a hand-editing mistake, and persisting the document without it
  // would make the loss permanent on the next write.
  if (dropped.length > 0) {
    throw new NotebookError(
      `notebook.json has ${dropped.length} unrecognised entr${
        dropped.length === 1 ? "y" : "ies"
      } (${dropped.join(", ")}). Every source and note needs a non-empty "id"; ` +
        "fix or remove them before continuing.",
    );
  }
  return {
    version: 1,
    title: typeof obj.title === "string" ? obj.title : undefined,
    sources,
    notes,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalTimestamp(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : new Date(0).toISOString();
}

/**
 * Normalise one hand-edited source entry so that reads (stats, exports, search)
 * never meet a missing field, and writes see the same shape the write paths
 * produce: tags trimmed/lowercased/deduped, authors deduped. Unknown keys
 * (e.g. a hand-added "isbn") are preserved so a load/save cycle is lossless.
 */
function normaliseSource(entry: unknown): Source | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as Partial<Source>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  return {
    ...raw,
    id: raw.id,
    citeKey:
      typeof raw.citeKey === "string" && raw.citeKey.length > 0
        ? raw.citeKey
        : `source-${raw.id}`,
    type: (SOURCE_TYPES as readonly string[]).includes(raw.type ?? "")
      ? (raw.type as SourceType)
      : "webpage",
    title: typeof raw.title === "string" ? raw.title : "",
    url: optionalString(raw.url),
    authors: dedupeStrings(stringArray(raw.authors)),
    container: optionalString(raw.container),
    publishedDate: optionalString(raw.publishedDate),
    accessedDate: optionalString(raw.accessedDate),
    doi: optionalString(raw.doi),
    tags: normaliseTags(stringArray(raw.tags)),
    quotes: Array.isArray(raw.quotes)
      ? raw.quotes.filter(
          (q): q is Quote =>
            Boolean(q) && typeof q === "object" && typeof (q as Quote).text === "string",
        )
      : [],
    summary: optionalString(raw.summary),
    createdAt: optionalTimestamp(raw.createdAt),
    updatedAt: optionalTimestamp(raw.updatedAt),
  };
}

/**
 * Normalise one hand-edited note entry so reads never meet a missing field;
 * unknown keys are preserved as for sources.
 */
function normaliseNote(entry: unknown): Note | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as Partial<Note>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  return {
    ...raw,
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    content: typeof raw.content === "string" ? raw.content : "",
    sourceIds: stringArray(raw.sourceIds),
    tags: normaliseTags(stringArray(raw.tags)),
    createdAt: optionalTimestamp(raw.createdAt),
    updatedAt: optionalTimestamp(raw.updatedAt),
  };
}
