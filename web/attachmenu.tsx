// The menu under a chat box's paperclip: Files…, A folder…. It is the app's dropdown (web/ui/dropdown.tsx); the chats'
// boxes are plain DOM, so it is drawn into a host element the tray's picker holds.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from './ui/dropdown.tsx';
import { Icon, IconWeightProvider } from './ui/react.tsx';
import type { IconWeight } from './ui/react.tsx';
import { buttonClass } from './ui/classes.ts';
import type { ButtonSize, ButtonVariant } from './ui/classes.ts';

/** label: words next to the paperclip (a dialog's "Add files / folders"); without, it is the chat box's bare paperclip. */
export function mountAttachMenu(host: HTMLElement, { files, folder, weight = 'light', button = {} }: { files: () => void; folder: () => void; weight?: IconWeight; button?: { variant?: ButtonVariant; size?: ButtonSize; class?: string; label?: string } }): void {
  createRoot(host).render(
    <StrictMode>
      {/* (its own React tree, so it is told the weight its chat draws icons in) */}
      <IconWeightProvider value={weight}>
        <Dropdown>
          <DropdownTrigger className={buttonClass(button.variant ?? 'ghost', button.size ?? 'small', button.class)} aria-label={button.label ? undefined : 'Attach files'} title="Attach files or a folder (or drop or paste them here)">
            <Icon name="paperclip" size={15} />
            {button.label || null}
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
