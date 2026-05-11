/**
 * Teams sends inbound `activity.text` as HTML when the user pastes a link
 * that the client auto-renders into a clickable card (Word docs, SharePoint
 * URLs, etc). The raw HTML often looks like:
 *
 *   <a href="https://contoso.sharepoint.com/foo.docx">foo.docx</a>
 *   <attachment id="..."></attachment>
 *
 * If we hand that HTML straight to the LLM, some models read the href fine,
 * but several Copilot/GHC paths see only the visible label "foo.docx" and
 * the URL is lost. Symptom kenan reported (2026-05-05): "Teams 链接被自动
 * 渲染的就看不到链接".
 *
 * `expandHtmlLinks` rewrites every <a href="URL">LABEL</a> as
 *   `LABEL (URL)`
 * if LABEL and URL differ, or just `URL` if LABEL == URL. Other HTML tags
 * are left alone — Teams' HTML is generally simple enough that pass-through
 * still works, and the existing comment in teams.ts notes "LLM can
 * understand HTML; stripping loses links and formatting" so we only
 * unwrap the one tag whose semantics we know we lose.
 */
export function expandHtmlLinks(text: string): string {
  if (!text || !/<a\s/i.test(text)) return text;
  return text.replace(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    if (!label) return href;
    if (label === href) return href;
    return `${label} (${href})`;
  });
}
