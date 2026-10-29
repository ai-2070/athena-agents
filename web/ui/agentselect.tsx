// A dropdown of agents, with each one's badge. (A plain <select> can only show the emoji as small text.)
import { Select } from '@base-ui/react/select';
import { Avatar, Icon } from './react.tsx';
import type { Agent } from '../../shared/types.ts';

// An agent to pick, drawn like the rest of the panel: its badge, its name, one even gap between them. (A
// plain <select> can only show the emoji as small text.)
export function AgentSelect({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (id: string) => void }) {
  const row = 'flex min-w-0 items-center gap-2.5 [&_.avatar]:size-6.5 [&_.avatar]:text-[14px]';
  const picked = agents.find((a) => a.id === value);
  return (
    <Select.Root value={value} onValueChange={(v) => v && onChange(String(v))}>
      <Select.Trigger aria-label="Agent to add" className="flex w-full cursor-pointer items-center gap-2.5 rounded-ctl border border-line-2 bg-panel px-2.5 py-1.5 text-left text-[13.5px] text-ink outline-none focus-visible:border-accent data-popup-open:border-accent">
        <span className={`${row} flex-1`}>
          {picked ? <Avatar agent={picked} /> : null}
          <span className="min-w-0 truncate">{picked?.name}</span>
        </span>
        <Select.Icon className="flex text-dim">
          <Icon name="chevron-down" size={16} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="z-96 outline-none" alignItemWithTrigger={false} side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <Select.Popup className="st-menu dd static max-h-72 min-w-(--anchor-width) max-w-none">
            <Select.List>
              {agents.map((a) => (
                <Select.Item key={a.id} value={a.id} className="st-menu-item">
                  <span className={`${row} flex-1`}>
                    <Avatar agent={a} />
                    <Select.ItemText className="min-w-0 truncate">{a.name}</Select.ItemText>
                  </span>
                  <Select.ItemIndicator className="flex text-accent">
                    <Icon name="check" size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
