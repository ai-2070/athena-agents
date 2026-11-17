// X's weighted post length (docs.x.com, "Counting characters"; twitter-text v3).
import { describe, expect, it } from 'vitest';
import { xLength, X_MAX_LENGTH, X_URL_LENGTH } from '../../shared/xtext.ts';

describe('xLength', () => {
  it('counts plain Latin text, punctuation and spaces as one each', () => {
    expect(xLength('')).toBe(0);
    expect(xLength('Hello, world!')).toBe(13);
    expect(xLength('x'.repeat(280))).toBe(X_MAX_LENGTH);
    // dashes and curly quotes are in the light ranges; the ellipsis is not
    expect(xLength('—“a”')).toBe(4);
    expect(xLength('…')).toBe(2);
  });

  it('counts Chinese, Japanese and Korean letters as two', () => {
    expect(xLength('日本語')).toBe(6);
    expect(xLength('한국어')).toBe(6);
    expect(xLength('中'.repeat(140))).toBe(280);
    expect(xLength('中'.repeat(141))).toBe(282);
  });

  it('counts every emoji as two, however many code points it has', () => {
    expect(xLength('👋')).toBe(2);
    expect(xLength('hi 👋')).toBe(5);
    expect(xLength('🙋🏽')).toBe(2); // with a skin tone
    expect(xLength('👨‍👩‍👧‍👦')).toBe(2); // four people joined by three ZWJs
    expect(xLength('🏳️‍🌈')).toBe(2);
    expect(xLength('🇯🇵')).toBe(2); // a flag
    expect(xLength('1️⃣')).toBe(2); // a keycap
    expect(xLength('❤️')).toBe(2);
    expect(xLength('©')).toBe(1); // a bare © is text
    // a joiner in ordinary text (a Devanagari conjunct) is no emoji: its letters weigh as they do
    expect(xLength('क्‍ष')).toBe(4);
  });

  it('counts a bare link with a less common ending as a link too', () => {
    expect(xLength('see example.museum')).toBe(4 + X_URL_LENGTH);
    expect(xLength('shop at goods.shop/new')).toBe(8 + X_URL_LENGTH);
  });

  it('measures after NFC normalization', () => {
    expect(xLength('café')).toBe(4);
    expect(xLength('café')).toBe(4);
  });

  it('counts any link as 23, without the punctuation after it', () => {
    expect(xLength('https://example.com')).toBe(X_URL_LENGTH);
    expect(xLength(`see https://example.com/${'a'.repeat(200)}?q=1.`)).toBe(4 + 23 + 1);
    expect(xLength('http://x.co')).toBe(23);
    expect(xLength('visit example.com/page!')).toBe(6 + 23 + 1);
    expect(xLength('(https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(1 + 23 + 1);
    expect(xLength('a https://a.com b https://b.org')).toBe(2 + 23 + 3 + 23);
  });

  it("doesn't take an email address or a file name for a link", () => {
    expect(xLength('me@example.com')).toBe(14);
    expect(xLength('notes.txt')).toBe(9);
  });
});
