# Research Notebook MCP

An MCP server that turns any BOSS agent into a research assistant. It gives your
agent (Claude Code, Codex, Gemini, OpenCode - anything BOSS drives) a set of
tools to **capture cited sources, keep linked notes, and export a bibliography
or a literature-review outline** - all stored as plain files inside the project
you are working in.

Point it at a project, browse and read as usual, and ask your agent to "cite
this page", "note down why this matters", or "draft an outline of what I have so
far". The notebook is a single human-readable `notebook.json` plus the Markdown
and BibTeX files it generates, so nothing is locked away.

## Why this helps researchers

The expensive part of a literature review is not reading, it is **keeping track**:
where a fact came from, which paper made which claim, and how a pile of notes
turns into a structured draft. A general chat agent forgets all of this between
turns. This server gives the agent a durable, structured memory built around the
two things a researcher actually accumulates:

- **Sources** you cite, with real bibliographic metadata (title, authors, date,
  journal or site, DOI) extracted automatically from the page.
- **Notes** you write, each linked to the sources behind it.

From those it can produce a BibTeX file for LaTeX/Overleaf, an annotated
bibliography, or a literature-review outline that groups your notes by theme and
threads in the right citations.

## The tools

| Tool | What it does |
|---|---|
| `cite_url` | Fetch a URL, extract its metadata, and save it as a source (de-duplicates by URL; adds your quote/tags to an existing source). |
| `add_source` | Record a source by hand (a book, or a page you cannot fetch). |
| `update_source` | Correct or enrich a source's fields. |
| `add_quote` | Attach an excerpt (with page/location and your comment) to a source. |
| `add_note` | Write a Markdown research note linked to the sources it draws on. |
| `update_note` | Edit a note's title, content, tags, or links. |
| `list_sources` / `list_notes` | List sources or notes, optionally filtered by tag (or by linked source). |
| `get_source` / `get_note` | Show full detail of one item, including quotes. |
| `search` | Full-text search across sources and notes. |
| `remove_source` / `remove_note` | Delete an item (removing a source unlinks it from notes and reports which). |
| `export_bibtex` | Render sources as BibTeX, optionally writing `references.bib`. |
| `export_markdown` | Render a Markdown bibliography (plain or annotated), optionally writing `references.md`. |
| `generate_outline` | Assemble notes into a literature-review scaffold, optionally writing `outline.md`. |
| `notebook_stats` | Counts of sources, notes, quotes, tags, and types. |

## Quick start

```bash
git clone https://github.com/Rushikeshiitb/boss-research-notebook-mcp.git
cd boss-research-notebook-mcp
npm install
npm run build
```

Run it directly (it speaks MCP over stdio):

```bash
RESEARCH_NOTEBOOK_DIR="$PWD/.research-notebook" node dist/index.js
```

Or install it on your `PATH` as `research-notebook-mcp` (the package declares a
`bin`):

```bash
npm install -g .          # from the cloned repo
# now `research-notebook-mcp` launches the server over stdio
```

### Cite keys

Sources get a human-friendly citation key in the usual author-year-word style,
for example `vaswani2017attention`. Collisions are disambiguated with a trailing
letter (`smith2020a`, `smith2020b`). You can refer to any source by either its
cite key or its internal id in every tool that takes a source.

## Connecting it to BOSS

BOSS drives coding CLIs (Claude Code, Codex, Gemini, OpenCode), and each of
them loads MCP servers from its own configuration - so you register this server
with the CLI you use inside BOSS. It is a stdio server: the client launches it
and talks over stdin/stdout.

**Project-scoped config file (portable across clients).** Drop a `.mcp.json` in
the root of the project you open in BOSS:

```json
{
  "mcpServers": {
    "research-notebook": {
      "command": "node",
      "args": ["/absolute/path/to/boss-research-notebook-mcp/dist/index.js"],
      "env": {
        "RESEARCH_NOTEBOOK_DIR": "/absolute/path/to/your/project/.research-notebook",
        "RESEARCH_NOTEBOOK_TITLE": "My Literature Review"
      }
    }
  }
}
```

**Claude Code, one command** (run it in your project directory):

```bash
claude mcp add research-notebook \
  -e RESEARCH_NOTEBOOK_DIR="$PWD/.research-notebook" \
  -- node /absolute/path/to/boss-research-notebook-mcp/dist/index.js
```

If you installed it globally (`npm install -g .`), the command is simply
`research-notebook-mcp` in place of `node .../dist/index.js`.

Once connected, the 17 tools above appear to your agent alongside the rest of
the tools it can call.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RESEARCH_NOTEBOOK_DIR` | `<cwd>/.research-notebook` | Folder holding `notebook.json` and the generated exports. |
| `RESEARCH_NOTEBOOK_TITLE` | (unset) | Sets the notebook title on first run, used in export headings. |

## What gets written

Everything lives in the notebook directory:

- `notebook.json` - the canonical store (sources and notes). Written atomically
  (unique temp file + rename) under an advisory lock.
- `references.bib` - BibTeX, when you ask `export_bibtex` to write.
- `references.md` - Markdown bibliography, when you ask `export_markdown` to write.
- `outline.md` - the literature-review scaffold, when you ask `generate_outline` to write.

Because it is all plain text in your project, it version-controls cleanly and you
can read or edit it without the server. Every source and note needs a non-empty
`id`; the server normalises array fields on load (missing ones become empty,
tags are lowercased and de-duplicated, unknown keys are kept) and refuses to
start if an entry cannot be read at all.

**Editing it while the server runs:** the server loads `notebook.json` once and
writes the whole document back on each change. If the file changes on disk
underneath it - you hand-edited it, or a second server shares the directory - the
next write is **refused** rather than silently overwriting your edit: the server
reloads the on-disk version and returns a conflict error asking you to re-apply
your change. A refused or failed write never corrupts the file or the in-memory
copy. Writes are serialized by a lock file, so two servers on one directory take
turns instead of clobbering each other.

## Example workflow

1. `cite_url` on a paper you are reading, with a `quote` and `tags: ["method"]`.
2. `add_note` capturing your take, linked to that source.
3. Repeat while you read.
4. `generate_outline` to get a themed draft with citations threaded in.
5. `export_bibtex` to drop `references.bib` into your LaTeX project.

## Privacy and safety

- The only outbound request the server makes is `cite_url` fetching a page.
  Because the **agent**, not you, picks that URL, the fetch is hardened against
  being pointed at your own network (SSRF):
  - only `http`/`https`;
  - the hostname is resolved and **every** address it returns is checked - the
    request is refused if any is loopback, private, link-local (cloud metadata at
    `169.254.169.254`), CGNAT or IPv6 loopback/ULA/link-local/mapped-private;
  - the connection is **pinned** to the validated address, so a name cannot be
    re-resolved to a private address after the check (DNS-rebinding);
  - redirects are followed manually and **each hop is re-validated**, so a public
    page cannot bounce the fetch to an internal one;
  - the response body is **capped** (5 MiB) and the fetch gives up after 30 s.
  Nothing else leaves your machine.
- All data is stored locally in the notebook directory. There is no external
  service and no telemetry.
- A failed or blocked fetch is reported cleanly; you can always fall back to
  `add_source` to record a citation by hand.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit + in-memory MCP integration tests
npm run build       # emit dist/
```

The test suite covers metadata extraction (OpenGraph, Google Scholar / highwire
`citation_*` tags, JSON-LD, and degenerate pages), cite-key generation and
collisions, the notebook store and its persistence, BibTeX and Markdown
rendering, and a full end-to-end pass driving the real MCP server over an
in-memory transport with a stubbed fetch.

### Layout

```
src/
  types.ts      data model (sources, notes, notebook)
  metadata.ts   pure HTML -> bibliographic metadata extraction
  citekey.ts    author-year-word cite keys, with de-duplication
  notebook.ts   the store: CRUD, search, atomic persistence
  bibtex.ts     BibTeX export
  markdown.ts   bibliography + literature-review outline
  server.ts     MCP tool registration (fetch and store injected)
  index.ts      stdio entry point
```

## License

Apache-2.0, matching the BOSS Console core.
