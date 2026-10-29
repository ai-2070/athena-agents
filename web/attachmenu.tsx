// The menu under a chat box's paperclip: Files…, A folder…. It is the app's dropdown (web/ui/dropdown.tsx); the chats'
// boxes are plain DOM, so it is drawn into a host element the tray's picker holds.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from './ui/dropdown.tsx';
import { Icon, IconWeightProvider } from './ui/react.tsx';
import type { IconWeight } from './ui/react.tsx';

export function mountAttachMenu(host: HTMLElement, { files, folder, weight = 'light' }: { files: () => void; folder: () => void; weight?: IconWeight }): void {
  createRoot(host).render(
    <StrictMode>
      {/* (its own React tree, so it is told the weight its chat draws icons in) */}
      <IconWeightProvider value={weight}>
        <Dropdown>
          <DropdownTrigger className="btn ghost small" aria-label="Attach files" title="Attach files or a folder (or drop or paste them here)">
            <Icon name="paperclip" size={15} />
          </DropdownTrigger>
          <DropdownContent side="top" align="end" className="min-w-40">
            <DropdownItem icon="file" onClick={files}>
              Files…
            </DropdownItem>
            <DropdownItem icon="folder-up" onClick={folder}>
              A folder…
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </IconWeightProvider>
    </StrictMode>,
  );
}
