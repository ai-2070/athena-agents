// Opening the Brain chat from the keyboard: Ctrl+K / ⌘K anywhere, Space on the Station.
import { afterEach, describe, expect, it } from 'vitest';
import { brainKeyLabel, brainKeyTitle, brainShortcut, chatWindowKeys, chatWindowShortcut } from '../../web/shortcuts.ts';

/** Presses a key on el (the page itself by default) and says what it does to the Brain chat. */
function press(init: KeyboardEventInit, ctx: { open?: boolean; onStation?: boolean } = {}, el: Element = document.body) {
  let out: ReturnType<typeof brainShortcut> = null;
  const listen = (e: Event) => (out = brainShortcut(e as KeyboardEvent, { open: false, onStation: true, ...ctx }));
  document.addEventListener('keydown', listen);
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  document.removeEventListener('keydown', listen);
  return out;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('brainShortcut()', () => {
  it('Ctrl+K and ⌘K toggle the chat anywhere, open or closed', () => {
    expect(press({ key: 'k', ctrlKey: true }, { onStation: false })).toBe('toggle');
    expect(press({ key: 'K', metaKey: true }, { onStation: false, open: true })).toBe('toggle');
  });

  it('Space opens it on the Station', () => {
    expect(press({ key: ' ' })).toBe('open');
  });

  it('Space does nothing off the Station, or when the chat is open already', () => {
    expect(press({ key: ' ' }, { onStation: false })).toBeNull();
    expect(press({ key: ' ' }, { open: true })).toBeNull();
  });

  it('Space with a modifier, held down, or mid-composition is not the shortcut', () => {
    expect(press({ key: ' ', shiftKey: true })).toBeNull();
    expect(press({ key: ' ', ctrlKey: true })).toBeNull();
    expect(press({ key: ' ', altKey: true })).toBeNull();
    expect(press({ key: ' ', repeat: true })).toBeNull();
    expect(press({ key: ' ', isComposing: true })).toBeNull();
  });

  it('Space while typing, or on a button or link, keeps its usual job', () => {
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>', '<button>Go</button>', '<a href="#x">x</a>', '<div contenteditable="true">x</div>', '<div role="button">x</div>']) {
      document.body.innerHTML = html;
      expect(press({ key: ' ' }, {}, document.body.firstElementChild!), html).toBeNull();
    }
    // a span inside a button counts as the button
    document.body.innerHTML = '<button><span>Go</span></button>';
    expect(press({ key: ' ' }, {}, document.querySelector('span')!)).toBeNull();
  });

  it('Space belongs to an open dialog or menu', () => {
    document.body.innerHTML = '<div class="modal-back"></div>';
    expect(press({ key: ' ' })).toBeNull();
    document.body.innerHTML = '<div class="model-menu"></div>';
    expect(press({ key: ' ' })).toBeNull();
  });

  it('other keys do nothing', () => {
    expect(press({ key: 'k' })).toBeNull();
    expect(press({ key: 'Enter' })).toBeNull();
  });
});

describe('the button label', () => {
  it('reads Space on the Station, Ctrl K elsewhere, and ⌘ K on a Mac', () => {
    expect(brainKeyLabel(true, false)).toBe('Space');
    expect(brainKeyLabel(true, true)).toBe('Space');
    expect(brainKeyLabel(false, false)).toBe('Ctrl K');
    expect(brainKeyLabel(false, true)).toBe('⌘ K');
  });

  it('its tooltip names every way in', () => {
    expect(brainKeyTitle(true)).toBe('Ask the Brain (⌘K, or Space on the Station)');
    expect(brainKeyTitle(false)).toBe('Ask the Brain (Ctrl+K, or Space on the Station)');
  });
});

describe('chatWindowShortcut()', () => {
  const key = (init: KeyboardEventInit, mac: boolean) => chatWindowShortcut(new KeyboardEvent('keydown', init), mac);

  it('⌘↓ minimizes and ⌘↑ brings back on a Mac; Ctrl elsewhere', () => {
    expect(key({ key: 'ArrowDown', metaKey: true }, true)).toBe('minimize');
    expect(key({ key: 'ArrowUp', metaKey: true }, true)).toBe('restore');
    expect(key({ key: 'ArrowDown', ctrlKey: true }, false)).toBe('minimize');
    expect(key({ key: 'ArrowUp', ctrlKey: true }, false)).toBe('restore');
  });

  it('the other modifier, extra modifiers, a held key or other keys are not it', () => {
    expect(key({ key: 'ArrowDown', ctrlKey: true }, true)).toBeNull();
    expect(key({ key: 'ArrowDown', metaKey: true }, false)).toBeNull();
    expect(key({ key: 'ArrowDown' }, true)).toBeNull();
    expect(key({ key: 'ArrowDown', metaKey: true, shiftKey: true }, true)).toBeNull();
    expect(key({ key: 'ArrowUp', metaKey: true, altKey: true }, true)).toBeNull();
    expect(key({ key: 'ArrowDown', metaKey: true, repeat: true }, true)).toBeNull();
    expect(key({ key: 'ArrowLeft', metaKey: true }, true)).toBeNull();
  });

  it('Ctrl+Alt (Ctrl+⌥) + arrows arrange: ← → snap, ↑ separates, ↓ combines', () => {
    for (const mac of [true, false]) {
      expect(key({ key: 'ArrowLeft', ctrlKey: true, altKey: true }, mac)).toBe('left');
      expect(key({ key: 'ArrowRight', ctrlKey: true, altKey: true }, mac)).toBe('right');
      expect(key({ key: 'ArrowUp', ctrlKey: true, altKey: true }, mac)).toBe('separate');
      expect(key({ key: 'ArrowDown', ctrlKey: true, altKey: true }, mac)).toBe('combine');
      expect(key({ key: 'ArrowLeft', ctrlKey: true, altKey: true, metaKey: true }, mac)).toBeNull();
      expect(key({ key: 'ArrowLeft', ctrlKey: true, altKey: true, shiftKey: true }, mac)).toBeNull();
    }
    // plain ⌘ / Ctrl + ← → stays with the text box (start of line, next word)
    expect(key({ key: 'ArrowLeft', metaKey: true }, true)).toBeNull();
    expect(key({ key: 'ArrowRight', ctrlKey: true }, false)).toBeNull();
  });

  it('the tooltips and the Layout menu show the keys', () => {
    expect(chatWindowKeys(true)).toEqual({ minimize: '⌘↓', restore: '⌘↑', left: '⌃⌥←', right: '⌃⌥→', separate: '⌃⌥↑', combine: '⌃⌥↓' });
    expect(chatWindowKeys(false)).toEqual({ minimize: 'Ctrl+↓', restore: 'Ctrl+↑', left: 'Ctrl+Alt+←', right: 'Ctrl+Alt+→', separate: 'Ctrl+Alt+↑', combine: 'Ctrl+Alt+↓' });
  });
});
