"use client";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
export function ChoiceSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      items={options}
      disabled={disabled}
    >
      <Select.Trigger className="agent-select-trigger" aria-label={label}>
        <Select.Value />
        <ChevronDown size={12} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="agent-menu-layer"
        >
          <Select.Popup className="agent-select-popup">
            <Select.List>
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className="agent-select-item"
                >
                  <Select.ItemText>{o.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={13} />
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
