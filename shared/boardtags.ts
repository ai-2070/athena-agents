// Tags on Tasks board tasks: the rules the server, the page, the Brain and agents share, so "bug" finds "🐛 Bug"
// everywhere. A tag is a name with an optional emoji; names count in characters as people see them (👩‍💻 is one).

export const TAG_NAME_MAX = 32;
export const TAGS_PER_PROJECT = 50;
export const TAGS_PER_TASK = 10;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (s: string): string[] => Array.from(graphemeSegmenter.segment(s), (x) => x.segment);

// (ES2023 has no \p{RGI_Emoji}: a pictograph, a keycap like 1️⃣, or a flag's two regional letters)
const PICTURE = /\p{Extended_Pictographic}|⃣|\p{Regional_Indicator}{2}/u;

/** One emoji, as one character on screen. */
export function isEmoji(s: string): boolean {
  const g = graphemes(s);
  return g.length === 1 && PICTURE.test(g[0]);
}

/** Spaces collapsed, ends trimmed. */
export const cleanTagText = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** "🐛 Bug" is the emoji 🐛 and the name Bug; a name that is only an emoji ("🔥") keeps it as its name. */
export function splitTag(text: string): { name: string; emoji?: string } {
  const t = cleanTagText(text);
  const first = graphemes(t)[0];
  if (first && isEmoji(first)) {
    const rest = t.slice(first.length).trim();
    if (rest) return { emoji: first, name: rest };
  }
  return { name: t };
}

/** What two tag names are compared by: lower case, without a leading emoji. */
export const tagKey = (text: string): string => splitTag(text).name.toLocaleLowerCase();

/** Why a tag name can't be used, or '' when it can. */
export function tagNameProblem(name: string): string {
  if (!name) return 'Give the tag a name.';
  if (graphemes(name).length > TAG_NAME_MAX) return `A tag's name can be up to ${TAG_NAME_MAX} characters.`;
  if (name.includes(',')) return 'A tag\'s name can\'t have a comma.';
  return '';
}

/** A tag as text: "🐛 Bug", or just "frontend". */
export const tagLabel = (t: { name: string; emoji?: string }): string => (t.emoji ? `${t.emoji} ${t.name}` : t.name);

export type TagMatch = 'any' | 'all';
/** Whether a task's tags (names) pass a filter of tag names: any or all of them; untagged also lets tasks with no tags through. */
export function tagsMatch(names: readonly string[], wanted: readonly string[], match: TagMatch = 'any', untagged = false): boolean {
  if (!wanted.length && !untagged) return true;
  if (untagged && !names.length) return true;
  if (!wanted.length) return false;
  const have = new Set(names.map(tagKey));
  const want = wanted.map(tagKey);
  return match === 'all' ? want.every((k) => have.has(k)) : want.some((k) => have.has(k));
}
