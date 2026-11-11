// How long a post is to X. X weighs characters (docs.x.com, "Counting characters", and the twitter-text v3
// config it points to): most Latin text, punctuation and common symbols count 1, everything else (CJK, most
// other scripts) counts 2, every emoji counts 2 however many code points it is made of, and any link counts 23
// because X wraps it in t.co. Text is measured after Unicode NFC normalization.

/** The most a post may weigh. */
export const X_MAX_LENGTH = 280;
/** What any link weighs, whatever its length. */
export const X_URL_LENGTH = 23;

// twitter-text v3: code points in these ranges weigh 1; everything else weighs 2.
const LIGHT: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const weightOf = (cp: number): number => (LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2);

// A grapheme that is an emoji: shown as an emoji by default, made one by U+FE0F, a flag, a keycap, or joined
// or skin-toned. (A bare © or ™ is text, and weighs 1.)
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}|⃣|‍|\p{Emoji_Modifier}/u;

// Links X shortens: with http(s)://, or a bare domain with a common ending (example.com/page). Not emails.
const TLDS =
  'com|org|net|io|ai|dev|co|app|me|gg|tv|xyz|info|edu|gov|uk|de|fr|jp|ca|au|us|ly|so|sh|to|be|nl|es|it|ch|se|no|fi|in|br|ru|cn|eu|news|blog|site|tech|online|store';
const URL = new RegExp(
  `https?://[^\\s<>"]+|(?<![@\\w./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])(?:[/?#][^\\s<>"]*)?`,
  'giu',
);

/** A link without the punctuation that ends the sentence around it ("see example.com." → "example.com"). */
function trimLink(link: string): string {
  let s = link.replace(/[.,!?;:'"]+$/, '');
  // a ")" that closes nothing in the link belongs to the text
  while (s.endsWith(')') && (s.match(/\(/g)?.length || 0) < (s.match(/\)/g)?.length || 0))
    s = s.slice(0, -1).replace(/[.,!?;:'"]+$/, '');
  return s;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function weighText(text: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI.test(segment)) n += 2;
    else for (const ch of segment) n += weightOf(ch.codePointAt(0) ?? 0);
  }
  return n;
}

/** The length X gives a post (its limit is X_MAX_LENGTH). */
export function xLength(text: string): number {
  const s = String(text ?? '').normalize('NFC');
  let n = 0;
  let at = 0;
  for (const m of s.matchAll(URL)) {
    const link = trimLink(m[0]);
    if (!link) continue;
    const start = m.index ?? 0;
    n += weighText(s.slice(at, start)) + X_URL_LENGTH;
    at = start + link.length;
  }
  return n + weighText(s.slice(at));
}
