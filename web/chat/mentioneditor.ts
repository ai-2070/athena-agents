// An editable rich view of the textarea. The textarea remains the plain-text source for chat helpers.
import { icon } from '../icons.ts';

/** A name the box shows as a pill, with an icon before it if it has one (a team, a skill). */
export type MentionTag = string | { tag: string; icon?: string };

export function attachMentionEditor(input: HTMLTextAreaElement, tags: () => MentionTag[]): () => void {
  const wasFocused = document.activeElement === input;
  const editor = document.createElement('div');
  editor.className = `${input.className} whitespace-pre-wrap overflow-y-auto`;
  editor.classList.remove('field-sizing-content', 'resize-none');
  editor.contentEditable = 'true';
  editor.setAttribute('contenteditable', 'true');
  editor.tabIndex = 0;
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', input.getAttribute('aria-label') || 'Message');
  editor.dataset.placeholder = input.placeholder;
  input.after(editor);
  input.hidden = true;
  const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  const focus = input.focus;
  const range = input.setSelectionRange;
  const plain = (node: Node): string => {
    if (node instanceof HTMLElement && node.dataset.mention) return node.dataset.mention;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node instanceof HTMLBRElement) return '\n';
    return [...node.childNodes].map((child, i) => `${i && child instanceof HTMLDivElement ? '\n' : ''}${plain(child)}`).join('');
  };
  const remember = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
    const selected = selection.getRangeAt(0);
    const before = selected.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(selected.startContainer, selected.startOffset);
    const start = plain(before.cloneContents()).length;
    range.call(input, start, start + plain(selected.cloneContents()).length);
  };
  let syncing = false;
  const changed = () => {
    value.set!.call(input, plain(editor));
    remember();
    syncing = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    syncing = false;
  };
  const draw = () => {
    const text = input.value;
    const known = tags().map((t) => (typeof t === 'string' ? { tag: t } : t)).sort((a, b) => b.tag.length - a.tag.length);
    editor.replaceChildren();
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (i && !/\s/.test(text[i - 1])) continue;
      const found = known.find(({ tag: t }) => text.slice(i, i + t.length).toLowerCase() === t.toLowerCase() && (!text[i + t.length] || /[\s.,!?;:]/.test(text[i + t.length])));
      if (!found) continue;
      const tag = found.tag;
      editor.append(document.createTextNode(text.slice(start, i)));
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.setAttribute('contenteditable', 'false');
      chip.dataset.mention = text.slice(i, i + tag.length);
      chip.className = 'inline-flex items-center gap-1 rounded-ctl bg-accent/10 px-1.5 text-accent font-medium align-baseline';
      if (found.icon) chip.append(icon(found.icon, 11));
      chip.append(document.createTextNode(chip.dataset.mention));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'inline-flex cursor-pointer items-center border-0 bg-transparent p-0 text-accent';
      remove.setAttribute('aria-label', `Remove ${chip.dataset.mention}`);
      remove.append(icon('x', 11));
      remove.addEventListener('mousedown', (e) => e.preventDefault());
      remove.addEventListener('click', () => { chip.remove(); changed(); editor.focus(); });
      chip.append(remove);
      editor.append(chip);
      i += tag.length - 1;
      start = i + 1;
    }
    editor.append(document.createTextNode(text.slice(start)));
  };
  const place = (start: number, end: number) => {
    const point = (offset: number): [Node, number] => {
      let remaining = offset;
      for (const child of editor.childNodes) {
        const length = plain(child).length;
        if (child.nodeType === Node.TEXT_NODE && remaining <= length) return [child, remaining];
        if (child instanceof HTMLElement && child.dataset.mention && remaining < length) return [editor, [...editor.childNodes].indexOf(child)];
        remaining -= length;
      }
      return [editor, editor.childNodes.length];
    };
    const selection = window.getSelection();
    const next = document.createRange();
    next.setStart(...point(start));
    next.setEnd(...point(end));
    selection?.removeAllRanges();
    selection?.addRange(next);
  };
  Object.defineProperty(input, 'value', { configurable: true, get: () => value.get!.call(input) as string, set: (text: string) => { value.set!.call(input, text); draw(); } });
  input.focus = () => { editor.focus(); place(input.selectionStart, input.selectionEnd); };
  input.setSelectionRange = (start, end, direction) => { range.call(input, start, end, direction); place(start ?? 0, end ?? start ?? 0); };
  const insertText = (text: string) => {
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const selected = selection.getRangeAt(0);
    selected.deleteContents();
    const node = document.createTextNode(text);
    selected.insertNode(node);
    selected.setStartAfter(node);
    selected.collapse(true);
    selection.removeAllRanges();
    selection.addRange(selected);
    changed();
  };
  // The pill right before the caret (back) or right after it, past any empty text; null when there is none or text
  // is selected. Browsers differ in what Backspace does next to a part that can't be edited, so the box does it itself.
  const pillBeside = (back: boolean): HTMLElement | null => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return null;
    const node = selection.anchorNode!;
    const offset = selection.anchorOffset;
    let next: Node | null;
    if (node.nodeType === Node.TEXT_NODE) {
      if (back ? offset > 0 : offset < (node.textContent || '').length) return null;
      next = back ? node.previousSibling : node.nextSibling;
    } else next = back ? node.childNodes[offset - 1] ?? null : node.childNodes[offset] ?? null;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent) next = back ? next.previousSibling : next.nextSibling;
    return next instanceof HTMLElement && next.dataset.mention ? next : null;
  };
  const removePill = (pill: HTMLElement) => {
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEndBefore(pill);
    const at = plain(before.cloneContents()).length;
    pill.remove();
    changed();
    input.setSelectionRange(at, at);
  };

  editor.addEventListener('input', changed);
  editor.addEventListener('click', remember);
  editor.addEventListener('keyup', remember);
  editor.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLButtonElement) return;
    // Backspace after a pill, or Delete before one, takes the whole pill
    const pill = (event.key === 'Backspace' || event.key === 'Delete') && !event.isComposing ? pillBeside(event.key === 'Backspace') : null;
    if (pill) {
      event.preventDefault();
      event.stopPropagation();
      return removePill(pill);
    }
    remember();
    const forwarded = new KeyboardEvent('keydown', { key: event.key, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.isComposing, bubbles: true, cancelable: true });
    input.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) event.preventDefault();
    // a new line as text, not the <div> the browser would add (a box that sends on Enter has taken it already)
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); insertText('\n'); }
    event.stopPropagation();
  });
  editor.addEventListener('paste', (event) => {
    remember();
    const forwarded = new ClipboardEvent('paste', { clipboardData: event.clipboardData, bubbles: true, cancelable: true });
    input.dispatchEvent(forwarded);
    event.preventDefault();
    if (!forwarded.defaultPrevented) insertText(event.clipboardData?.getData('text/plain') || '');
  });
  const attributes = new MutationObserver(() => { editor.dataset.placeholder = input.placeholder; });
  attributes.observe(input, { attributes: true, attributeFilter: ['placeholder'] });
  const syncFromInput = () => {
    if (syncing) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    draw();
    if (document.activeElement === editor) place(start, end);
  };
  input.addEventListener('input', syncFromInput);
  draw();
  if (wasFocused) input.focus();
  return () => {
    const focused = document.activeElement === editor;
    input.removeEventListener('input', syncFromInput);
    attributes.disconnect();
    delete (input as unknown as Record<string, unknown>).value;
    input.focus = focus;
    input.setSelectionRange = range;
    input.hidden = false;
    editor.remove();
    if (focused) focus.call(input);
  };
}
