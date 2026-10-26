// "/queue <message>": send the message once the agent (or the team, or the Brain) is done with what
// it is doing now, instead of being turned away while it works.

/** The message after /queue ('' when nothing follows it), or null when the text isn't a /queue. */
export function queuedText(text: string): string | null {
  const m = /^\/queue(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] || '').trim() : null;
}
