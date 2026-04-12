---
title: Wiki Schema
last_updated: {{DATE}}
---

# Wiki Schema

Conventions and structure for this knowledge base.

## File Organization

- `concepts/` — One file per concept or topic. Use kebab-case: `agent-memory.md`
- `entities/` — One file per entity (person, tool, org). Use kebab-case: `andrej-karpathy.md`
- `sources/` — One summary per ingested source. Use kebab-case: `llm-wiki-pattern.md`

## Page Format

Every page has YAML frontmatter with:
- `title` — Human-readable page title
- `tags` — Array of topic tags for categorization
- `sources` — Array of source filenames this page draws from
- `last_updated` — ISO date of last modification

## Cross-Referencing

Use `[[wikilinks]]` to connect related pages:
- `[[concept-name]]` links to `concepts/concept-name.md`
- `[[entity-name]]` links to `entities/entity-name.md`
- Every page should have a "Related" section at the bottom

## Naming

- File names: lowercase, kebab-case, `.md` extension
- Keep names concise but descriptive
- Avoid abbreviations unless universally known

## Quality Standards

- Every concept page should cite at least one source
- Every source should link to the concepts/entities it covers
- Index must be updated on every ingest
- Log must be appended on every operation
