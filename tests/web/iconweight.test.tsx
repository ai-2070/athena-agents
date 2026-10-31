// Icon weight: Light everywhere, a step stronger (Regular) inside a part of the page that asks for it, like the Station panel.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileIcon, FolderIcon, VSCodeIcon } from '../../web/ui/fileicons.tsx';
import { Icon, IconWeightProvider } from '../../web/ui/react.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => act(() => root.unmount()));

const show = (node: ReactNode) => act(() => root.render(node));
// the first path's drawing, which differs between the weights
const shape = (i = 0) => document.querySelectorAll('svg')[i]!.querySelector('path')!.getAttribute('d');

describe('icon weight', () => {
  it('draws Light unless something around it asks for more', () => {
    show(<Icon name="x" />);
    const light = shape();
    show(
      <IconWeightProvider value="regular">
        <Icon name="x" />
      </IconWeightProvider>,
    );
    expect(shape()).not.toBe(light);
  });

  it('gives the folder and file icons the same weight as the icons beside them', () => {
    show(
      <>
        <FolderIcon />
        <FileIcon name="notes.md" />
      </>,
    );
    const light = [shape(0), shape(1)];
    show(
      <IconWeightProvider value="regular">
        <FolderIcon />
        <FileIcon name="notes.md" />
      </IconWeightProvider>,
    );
    expect(shape(0)).not.toBe(light[0]);
    expect(shape(1)).not.toBe(light[1]);
  });

  it('thickens the VS Code line to match', () => {
    const width = () => document.querySelector('svg')!.getAttribute('stroke-width');
    show(<VSCodeIcon />);
    const light = Number(width());
    show(
      <IconWeightProvider value="regular">
        <VSCodeIcon />
      </IconWeightProvider>,
    );
    expect(Number(width())).toBeGreaterThan(light);
  });
});
