// A dropdown menu: the parts of ReUI's DropdownMenu (shadcn's, on Base UI's Menu) with this app's look, which the
// .st-menu classes in components.css carry. Arrow keys move through it, Enter picks, Esc or a click elsewhere closes it,
// and it flips to the other side of what it opens from when there's no room. (The Station's right-click menu is the
// same menu on a point instead of a button: web/views/stationmenu.tsx.)
//
//   <Dropdown>
//     <DropdownTrigger className="btn ghost">Options</DropdownTrigger>
//     <DropdownContent>
//       <DropdownItem icon="user" onClick={…}>Profile</DropdownItem>
//     </DropdownContent>
//   </Dropdown>
import { Menu } from '@base-ui/react/menu';
import type { ReactNode } from 'react';
import { Icon } from './react.tsx';

/** The menu's state (it is not modal: the page behind keeps scrolling, like a menu in a native app). */
export function Dropdown(props: Menu.Root.Props) {
  return <Menu.Root modal={false} {...props} />;
}

/** What opens it: a button (give it your own classes). */
export const DropdownTrigger = Menu.Trigger;

/** The popup, placed against the trigger. Put what to show as children. */
export function DropdownContent({ side = 'bottom', align = 'start', sideOffset = 6, className = '', children, ...popup }: Menu.Popup.Props & Pick<Menu.Positioner.Props, 'side' | 'align' | 'sideOffset'>) {
  return (
    <Menu.Portal>
      <Menu.Positioner className="z-96 outline-none" side={side} align={align} sideOffset={sideOffset} collisionPadding={8}>
        <Menu.Popup className={`st-menu dd static ${className}`.trim()} {...popup}>
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

/** Something to do: an icon (a name from web/phosphor.ts), then its words. danger: red, for what deletes. */
export function DropdownItem({ icon, danger = false, className = '', children, ...item }: Menu.Item.Props & { icon?: string; danger?: boolean }) {
  return (
    <Menu.Item className={`st-menu-item${danger ? ' danger' : ''} ${className}`.trim()} {...item}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </Menu.Item>
  );
}

/** A named part of the menu: <DropdownGroup><DropdownLabel>Agents</DropdownLabel>…items…</DropdownGroup> */
export const DropdownGroup = Menu.Group;
export function DropdownLabel({ children }: { children: ReactNode }) {
  return <Menu.GroupLabel className="st-menu-head">{children}</Menu.GroupLabel>;
}
export function DropdownSeparator() {
  return <Menu.Separator className="st-menu-sep" />;
}

/** One choice out of several: the one picked has a check at the right; picking closes the menu. */
export const DropdownRadioGroup = Menu.RadioGroup;
export function DropdownRadioItem({ icon, className = '', children, ...item }: Menu.RadioItem.Props & { icon?: ReactNode }) {
  return (
    <Menu.RadioItem closeOnClick className={`st-menu-item ${className}`.trim()} {...item}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Menu.RadioItemIndicator className="flex text-accent">
        <Icon name="check" size={14} />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}
