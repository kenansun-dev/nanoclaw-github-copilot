---
name: wiki
description: >
  Personal LLM Wiki — compile, interlink, and query structured knowledge.
  Triggers on: /wiki, "add to wiki", "add to knowledge base", "research this",
  "ingest this", user shares articles/links/documents for deep processing,
  or queries accumulated knowledge ("what does my wiki say about X?").
  Do NOT use for simple reminders, preferences, or daily notes — those belong
  in memory files.
version: 1.0.0
---

# LLM Wiki — Personal Knowledge Base

You maintain a persistent, structured wiki for the user. Unlike memory files
(quick notes), the wiki is a **compiled knowledge base** — each source is
deeply processed, cross-referenced, and integrated into existing knowledge.

## Architecture

```
wiki/                    ← You own this — create, update, interlink
  index.md               ← Master catalog (read this FIRST on any query)
  log.md                 ← Append-only chronological record
  schema.md              ← Wiki conventions and structure reference
  concepts/              ← Concept pages (one topic per file)
  entities/              ← Entity pages (people, tools, orgs)
  sources/               ← Source summaries (one per ingested item)
```

All files use **Obsidian-compatible format**:
- YAML frontmatter: `title`, `tags`, `sources`, `last_updated`
- Cross-references: `[[wikilinks]]` between pages
- Markdown with headers, lists, code blocks

## Operations

### 1. Ingest

When the user shares a URL, file, or text to add to the wiki:

1. **Download/read the full content** — for URLs use `curl -sL` to get full text, not just a summary
2. **Discuss takeaways** — briefly tell the user what you found interesting
3. **Create/update wiki pages**:
   - Source summary page in `wiki/sources/`
   - Create or update relevant concept pages in `wiki/concepts/`
   - Create or update entity pages in `wiki/entities/`
   - Add `[[wikilinks]]` cross-references between pages
4. **Update `wiki/index.md`** — add new entries with one-line descriptions
5. **Append to `wiki/log.md`** — `## [YYYY-MM-DD] ingest | Source Title`
6. Tell the user what pages were created/updated

**Critical**: Process one source at a time. Read it fully, create all pages,
update all cross-references, then move to the next. Never batch-read multiple
sources and process them together — this produces shallow, generic pages.

**Per-source impact**: A single source typically touches 5-15 wiki pages.

### 2. Query

When the user asks a question about their knowledge base:

1. **Read `wiki/index.md`** first — find relevant pages by scanning summaries
2. **Read the relevant wiki pages** — drill into concepts, entities, sources
3. **Synthesize an answer** — combine information across pages
4. **Cite sources** — reference the wiki pages used: `(see [[page-name]])`
5. **Optionally file the answer** — if the answer is substantive, offer to
   save it as a new wiki page (explorations compound in the knowledge base)

### 3. Lint

When triggered by `/wiki lint` or periodically:

Check the wiki for:
- **Contradictions** — claims that conflict between pages
- **Orphan pages** — no inbound `[[wikilinks]]` from other pages
- **Stale content** — superseded by newer sources
- **Missing pages** — concepts mentioned but lacking dedicated pages
- **Missing cross-references** — related pages not linked
- **Gaps** — important topics with insufficient coverage

Report findings and offer to fix issues.

## Auto-initialization

If `wiki/` directory doesn't exist when the user first triggers the wiki skill,
create the full directory structure with template files:

```bash
mkdir -p wiki/concepts wiki/entities wiki/sources
```

Then create `wiki/index.md`, `wiki/log.md`, and `wiki/schema.md` from the
templates below.

## Page Format

Every wiki page should follow this template:

```markdown
---
title: Page Title
tags: [tag1, tag2]
sources: [source-file-1, source-file-2]
last_updated: YYYY-MM-DD
---

# Page Title

Brief 2-3 sentence summary.

## Content

Main body with structured information.

## Related

- [[related-concept-1]]
- [[related-entity-1]]
```

## Messaging Format

When reporting ingest results to the user:

```
📖 Ingested: [Source Title]

Created:
  • wiki/concepts/new-concept.md
  • wiki/entities/new-entity.md
  • wiki/sources/source-summary.md

Updated:
  • wiki/concepts/existing-concept.md (added new section)

Wiki now has X pages across Y concepts.
```

## Important Notes

- The wiki is NOT memory. Memory is for quick personal notes ("remember I prefer dark mode").
  The wiki is for compiled, structured knowledge from external sources.
- Always read `index.md` before answering wiki queries — don't guess from memory.
- Quality over speed — one well-integrated source is better than five shallow ones.
- Use `[[wikilinks]]` liberally — connections between pages are as valuable as the pages themselves.
- The user can browse wiki files directly (e.g., with Obsidian). Keep them clean and readable.
