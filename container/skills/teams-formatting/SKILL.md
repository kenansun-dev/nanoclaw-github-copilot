---
name: teams-formatting
description: Format messages for Microsoft Teams. Use when responding to Teams channels (folder starts with "teams_" or JID contains "teams:" identifiers).
---

# Microsoft Teams Message Formatting

When responding to Teams channels, use Teams-compatible Markdown. Teams supports a **subset** of standard Markdown — some features work differently or are unsupported.

## How to detect Teams context

Check your group folder name or workspace path:
- Folder starts with `teams_` (e.g., `teams_kenan-teams`)
- Or the chat JID starts with `teams:`

## Formatting reference

### Text styles

| Style | Syntax | Notes |
|-------|--------|-------|
| Bold | `**text**` | Standard Markdown bold ✅ |
| Italic | `*text*` or `_text_` | Both work ✅ |
| Strikethrough | `~~text~~` | Supported ✅ |
| Code (inline) | `` `code` `` | Supported ✅ |
| Code block | ` ```language\ncode\n``` ` | Supported with syntax highlighting ✅ |
| Blockquote | `> quote` | Supported ✅ |

### Headings

Teams supports headings:
```
# Heading 1
## Heading 2
### Heading 3
```

### Links

Standard Markdown links work:
```
[Link text](https://example.com)
```

### Lists

**Ordered lists:**
```
1. First item
2. Second item
3. Third item
```

**Unordered lists:**
```
- First item
- Second item
- Third item
```

Or with `*` or `•`:
```
* First item
* Second item
```

### Images

```
![Alt text](https://example.com/image.png)
```

### Horizontal rules

```
---
```

## What NOT to use

- **NO** tables in text messages (use code blocks for tabular data instead)
- **NO** complex nested Markdown (keep it simple)
- **NO** HTML tags (Teams bot messages use Markdown, not HTML for text-only)
- **Avoid** very long messages (>80KB) — Teams has a ~100KB limit per message

## Differences from other platforms

| Feature | Teams | WhatsApp | Slack | Discord |
|---------|-------|----------|-------|---------|
| Bold | `**text**` | `*text*` | `*text*` | `**text**` |
| Italic | `*text*` | `_text_` | `_text_` | `*text*` |
| Headings | `# H1` supported | Not supported | Not supported | Not supported |
| Links | `[text](url)` | Plain URL | `<url\|text>` | `[text](url)` |
| Tables | Not supported | Not supported | Not supported | Not supported |
| Code blocks | ` ```lang ``` ` | ` ``` ``` ` | ` ``` ``` ` | ` ```lang ``` ` |

## Example message

```markdown
# Daily Standup Summary

*March 29, 2026*

**Completed:**
- Fixed authentication bug in login flow
- Updated API documentation

**In Progress:**
- Building new dashboard widgets

**Blocked:**
> Waiting on API access from DevOps

---

✅ All tests passing | [View Build](https://ci.example.com/builds/123)
```

## Quick rules

1. Use `**bold**` (double asterisks) — Teams standard
2. Use `*italic*` (single asterisks)
3. Use `[text](url)` for links
4. Headings work (`#`, `##`, `###`)
5. Code blocks with language highlighting work
6. No tables — use code blocks or bullet lists instead
7. Keep messages under 80KB
