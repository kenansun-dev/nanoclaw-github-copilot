// Fast-abort keyword detection for inbound messages.
//
// Adapted from OpenClaw's auto-reply/reply/abort.ts. The idea:
// if a user sends 'stop' / 'cancel' / '停' etc. while an agent is running,
// we should kill the agent and clear its queue BEFORE routing the message
// through the LLM. Otherwise the keyword becomes a prompt ('stop' gets
// interpreted by the model) and the user has no cheap way to interrupt.
//
// Conservative set (vs OpenClaw's 45): we excluded 'wait' / 'exit' because
// they appear often in normal conversation ('wait, let me think', 'exit the
// loop', etc.). Expand later if needed; make this config-driven if we need
// per-group overrides.

const ABORT_TRIGGERS = new Set<string>([
  'stop',
  'cancel',
  'abort',
  'interrupt',
  'esc',
  'halt',
  '/stop',
  '/cancel',
  '/abort',
  // CJK
  '停',
  '停止',
  '取消',
  '中止',
  'やめて',
  '止めて',
  // Spanish / French / German / Portuguese / Russian — common
  'parar',
  'pare',
  'arrete',
  'arrête',
  'stopp',
  'anhalten',
  'стоп',
  'остановись',
]);

const TRAILING_PUNCT_RE = /[.!?…,，。;；:：'"''")\]}]+$/u;

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(TRAILING_PUNCT_RE, '')
    .trim();
}

/**
 * Returns true if the given inbound message text should trigger a fast-abort
 * (immediate agent kill + queue clear, no LLM call).
 */
export function isAbortRequestText(text?: string | null): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  if (!normalized) return false;
  return ABORT_TRIGGERS.has(normalized);
}

/** Exposed for unit tests. */
export const __ABORT_TRIGGERS = ABORT_TRIGGERS;
