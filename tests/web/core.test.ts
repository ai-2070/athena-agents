import { describe, expect, it } from 'vitest';
import { ago, h, mount } from '../../web/core.ts';

describe('h()', () => {
  it('builds elements from tag.class#id notation', () => {
    const el = h('div.card.big#main', 'hi');
    expect(el.tagName).toBe('DIV');
    expect(el.id).toBe('main');
    expect([...el.classList]).toEqual(['card', 'big']);
    expect(el.textContent).toBe('hi');
  });

  it('sets attributes, handlers and nested children (skipping null/false)', () => {
    let clicked = 0;
    const el = h('button', { title: 'Go', onclick: () => clicked++ }, 'A', null, false, ['B', ['C']], 2);
    el.click();
    expect(clicked).toBe(1);
    expect(el.title).toBe('Go');
    expect(el.textContent).toBe('ABC2');
  });

  it('applies style objects, including CSS variables like --c', () => {
    const el = h('div', { style: { fontSize: '12px', '--c': '#ff0000' } });
    expect(el.style.fontSize).toBe('12px');
    // CSS variables need setProperty; this used to be dropped silently
    expect(el.style.getPropertyValue('--c')).toBe('#ff0000');
  });

  it('gives typed elements for inputs', () => {
    const input = h('input', { value: 'abc' });
    expect(input.value).toBe('abc');
  });

  it('mount replaces the children', () => {
    const box = h('div', 'old');
    mount(box, h('span', 'new'), 'text');
    expect(box.innerHTML).toBe('<span>new</span>text');
  });
});

// md() is tested in markdown.test.ts (in jsdom, where the sanitizer runs for real)

describe('ago()', () => {
  it('says how long ago, in short words', () => {
    expect(ago(Date.now())).toMatch(/now|s ago/);
    expect(ago(Date.now() - 5 * 60_000)).toMatch(/5m/);
    expect(ago(Date.now() - 3 * 3600_000)).toMatch(/3h/);
    expect(ago(null)).toBe('');
  });
});
