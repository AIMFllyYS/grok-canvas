"use client";

import { ControlButton } from "@/components/ui/control-button";

import { useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";

/** Click-to-rename node title. Edits locally, commits on Enter/blur, Esc cancels (IME-safe). */
export function NodeTitle({ nodeId, name }: { nodeId: string; name: string }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (value: string) => {
    updateNodeData(nodeId, { name: value.trim() });
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={name}
        autoFocus
        className="nodrag w-full rounded-sm bg-transparent px-1 py-0.5 text-sm font-medium outline-none ring-1 ring-primary"
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter") {
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <ControlButton
      className="nodrag flex min-w-0 items-center gap-1.5 text-left"
      onClick={() => setEditing(true)}
      title="点击重命名"
    >
      <span className={`truncate text-sm font-medium ${name ? "" : "text-muted-foreground"}`}>
        {name || "点击命名"}
      </span>
    </ControlButton>
  );
}
