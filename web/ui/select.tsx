// A compact, keyboard-accessible select using the same glass popup as the app's menus.
import { Select } from '@base-ui/react/select';
import { fieldTriggerClass } from './classes.ts';
import { Icon } from './react.tsx';

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectControl({ options, value, onChange, 'aria-label': ariaLabel, className = '' }: {
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  'aria-label'?: string;
  className?: string;
}) {
  const picked = options.find((option) => option.value === value);
  return (
    <Select.Root value={value} onValueChange={(next) => { if (next !== null) onChange(String(next)); }}>
      <Select.Trigger aria-label={ariaLabel} className={fieldTriggerClass('field', `min-w-0 text-ink ${className}`)}>
        <span className="min-w-0 flex-1 truncate">{picked?.label}</span>
        <Select.Icon className="flex flex-none text-dim"><Icon name="chevron-down" size={16} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="z-96 outline-none" alignItemWithTrigger={false} side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Select.Popup className="st-menu dd static max-h-72 min-w-(--anchor-width) max-w-none">
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value} className="st-menu-item">
                  <Select.ItemText className="min-w-0 flex-1 truncate">{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="flex text-accent"><Icon name="check" size={14} /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
