import { afterEach, describe, expect, it } from 'vitest';
import { attachMentionEditor } from '../../web/chat/mentioneditor.ts';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });
const open = (text: string) => {
  const input = document.createElement('textarea');
  input.value = text;
  document.body.append(input);
  dispose = attachMentionEditor(input, () => ['@Ana', '#Design']);
  return { input, editor: document.querySelector<HTMLElement>('[contenteditable="true"]')! };
};

describe('inline mention editor', () => {
  it('keeps chips between the words they were inserted into', () => {
    const { input, editor } = open('Ask @Ana to help #Design today');
    expect([...editor.childNodes].map((n) => n.textContent)).toEqual(['Ask ', '@Ana', ' to help ', '#Design', ' today']);
    expect(input.value).toBe('Ask @Ana to help #Design today');
    editor.querySelector<HTMLButtonElement>('[aria-label="Remove @Ana"]')!.click();
    expect(input.value).toBe('Ask  to help #Design today');
    expect(editor.querySelector('[data-mention="#Design"]')).not.toBeNull();
  });

  it('tracks the caret and replaces a suggestion in the middle of a message', () => {
    const { input, editor } = open('Ask @An tomorrow');
    input.focus();
    input.setSelectionRange(7, 7);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' }));
    expect(input.selectionStart).toBe(7);
    input.value = 'Ask @Ana tomorrow';
    input.setSelectionRange(9, 9);
    expect(editor.querySelector('[data-mention="@Ana"]')).not.toBeNull();
    expect(editor.textContent).toBe('Ask @Ana tomorrow');
  });

  it('forwards send keys without inserting a newline', () => {
    const { input, editor } = open('@Ana hi');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    editor.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(input.value).toBe('@Ana hi');
  });

  it('puts an icon before a pill that has one', () => {
    const input = document.createElement('textarea');
    input.value = 'Ask @Ana and @Design with @Brand voice';
    document.body.append(input);
    dispose = attachMentionEditor(input, () => ['@Ana', { tag: '@Design', icon: 'users' }, { tag: '@Brand voice', icon: 'puzzle' }]);
    const pill = (m: string) => document.querySelector(`[data-mention="${m}"]`)!;
    expect(pill('@Ana').firstElementChild?.tagName.toLowerCase()).toBe('button');
    expect(pill('@Design').firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(pill('@Brand voice').firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(input.value).toBe('Ask @Ana and @Design with @Brand voice');
  });

  it('puts a new line in as text when the box does not take Enter itself', () => {
    const { input, editor } = open('@Ana hi');
    input.focus();
    input.setSelectionRange(7, 7);
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    editor.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(input.value).toBe('@Ana hi\n');
  });

  it('shows changes made by textarea helpers and restores the textarea on cleanup', () => {
    const { input, editor } = open('Hi');
    input.setRangeText(' @Ana', 2, 2, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.querySelector('[data-mention="@Ana"]')).not.toBeNull();
    dispose!(); dispose = undefined;
    expect(input.hidden).toBe(false);
    input.value = 'A new draft';
    expect(input.value).toBe('A new draft');
  });
});
