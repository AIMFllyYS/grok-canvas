"use client";

import { ControlButton } from "@/components/ui/control-button";
import { PopoverSurface } from "@/components/ui/popover-surface";
import { Popover } from "@base-ui/react/popover";
import { useDesktopAvailable } from "@/components/desktop-workspace";
import {
  VIDEO_REFERENCE_MAX,
  VIDEO_ROLE_LABELS,
  moveVideoSlot,
  setVideoSlotRole,
  type VideoInputRole,
  type VideoSlot,
} from "@/lib/video-references";
import { Plus, X } from "lucide-react";
import { useState, type DragEvent } from "react";

const ROLE_OPTIONS: VideoInputRole[] = ["first", "last", "reference"];

/** 素材槽内拖拽缩略图时使用的 dataTransfer 类型，载荷为槽位 key。 */
const DRAG_TYPE = "application/x-video-slot";

type DropTarget = {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
  active: boolean;
};

function RolePicker({ slot, slots, onChange }: {
  slot: VideoSlot;
  slots: VideoSlot[];
  onChange: (next: VideoSlot[]) => void;
}) {
  const available = useDesktopAvailable();
  const referencesFull = slot.role !== "reference"
    && slots.filter((item) => item.role === "reference").length >= VIDEO_REFERENCE_MAX;
  return (
    <Popover.Root>
      <Popover.Trigger
        data-ui-control="true"
        title="更改素材角色"
        aria-label={`角色：${VIDEO_ROLE_LABELS[slot.role]}`}
        className="ui-parameter-trigger max-w-12 truncate rounded px-0.5 text-[10px] leading-none text-muted-foreground outline-none hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        {VIDEO_ROLE_LABELS[slot.role]}
      </Popover.Trigger>
      {available ? (
        <Popover.Portal>
          <Popover.Positioner side="top" sideOffset={6} align="center" className="isolate z-50 outline-none">
            <PopoverSurface className="ui-settings-popup w-24 p-1">
              {ROLE_OPTIONS.map((role) => {
                const blocked = role === "reference" && referencesFull;
                return (
                  <ControlButton
                    key={role}
                    type="button"
                    aria-pressed={slot.role === role}
                    disabled={blocked}
                    title={blocked ? `参考图最多 ${VIDEO_REFERENCE_MAX} 张` : undefined}
                    onClick={() => { if (!blocked) onChange(setVideoSlotRole(slots, slot.key, role)); }}
                    className={`ui-parameter-option flex h-8 w-full items-center rounded-md px-2 text-xs ${
                      slot.role === role ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                    } disabled:opacity-40`}
                  >
                    {VIDEO_ROLE_LABELS[role]}
                  </ControlButton>
                );
              })}
            </PopoverSurface>
          </Popover.Positioner>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}

function SlotThumb({ slot, slots, onChange, onRemove, drop }: {
  slot: VideoSlot;
  slots: VideoSlot[];
  onChange: (next: VideoSlot[]) => void;
  onRemove: (slot: VideoSlot) => void;
  drop?: DropTarget;
}) {
  const label = VIDEO_ROLE_LABELS[slot.role];
  return (
    <span
      className="flex w-12 flex-col items-center gap-1"
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
    >
      <span
        className={`group relative rounded-md ${drop?.active ? "ring-2 ring-primary" : ""}`}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, slot.key);
          event.dataTransfer.effectAllowed = "move";
        }}
        title="拖到其他素材上：跨角色交换，参考图之间调整顺序"
      >
        {slot.assetName ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/assets/${slot.assetName}`}
            alt={slot.name}
            className="h-12 w-12 rounded-md border object-cover"
            draggable={false}
          />
        ) : (
          <span
            className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground"
            title="未就绪，暂不参与"
          >
            未就绪
          </span>
        )}
        <ControlButton
          className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-secondary text-muted-foreground shadow hover:text-foreground"
          onClick={() => onRemove(slot)}
          aria-label={`移除${label}`}
          title={slot.edgeId ? "移除（删除连线）" : "移除附件"}
        >
          <X className="h-3 w-3" />
        </ControlButton>
      </span>
      <RolePicker slot={slot} slots={slots} onChange={onChange} />
    </span>
  );
}

function EmptyRoleSlot({ role, onUpload, drop }: { role: "first" | "last"; onUpload: () => void; drop?: DropTarget }) {
  const label = VIDEO_ROLE_LABELS[role];
  return (
    <span
      className="flex w-12 flex-col items-center gap-1"
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
    >
      <ControlButton
        className={`flex h-12 w-12 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:text-foreground ${drop?.active ? "ring-2 ring-primary" : ""}`}
        onClick={onUpload}
        title={`选择或上传${label}，也可把其他素材拖到这里`}
        aria-label={`选择${label}`}
      >
        <Plus className="h-4 w-4" />
      </ControlButton>
      <span className="text-[10px] leading-none text-muted-foreground">{label}</span>
    </span>
  );
}

export function VideoInputSlots({
  slots,
  onChange,
  onRemove,
  onUpload,
}: {
  slots: VideoSlot[];
  onChange: (next: VideoSlot[]) => void;
  onRemove: (slot: VideoSlot) => void;
  onUpload: (role?: VideoInputRole) => void;
}) {
  const first = slots.find((slot) => slot.role === "first");
  const last = slots.find((slot) => slot.role === "last");
  const references = slots.filter((slot) => slot.role === "reference");
  const [dropKey, setDropKey] = useState<string | null>(null);

  const dropBase = (key: string) => ({
    active: dropKey === key,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropKey(key);
    },
    onDragLeave: () => setDropKey((current) => (current === key ? null : current)),
  });

  /** 落到已有素材上：同角色按光标左右半区插入排序，跨角色对调。 */
  const slotDrop = (key: string): DropTarget => ({
    ...dropBase(key),
    onDrop: (event) => {
      event.stopPropagation();
      setDropKey(null);
      const fromKey = event.dataTransfer.getData(DRAG_TYPE);
      if (!fromKey || fromKey === key) return;
      event.preventDefault();
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const place = event.clientX > rect.left + rect.width / 2 ? "after" : "before";
      onChange(moveVideoSlot(slots, fromKey, key, place));
    },
  });

  /** 落到空的首帧/尾帧槽：直接担任该角色。 */
  const roleDrop = (role: "first" | "last"): DropTarget => ({
    ...dropBase(`empty:${role}`),
    onDrop: (event) => {
      event.stopPropagation();
      setDropKey(null);
      const fromKey = event.dataTransfer.getData(DRAG_TYPE);
      if (!fromKey) return;
      event.preventDefault();
      onChange(setVideoSlotRole(slots, fromKey, role));
    },
  });

  /** 落到素材行空白处（含参考区空态）：首帧/尾帧降回参考区。 */
  const rowDrop = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent) => {
      setDropKey(null);
      const fromKey = event.dataTransfer.getData(DRAG_TYPE);
      if (!fromKey) return;
      const dragged = slots.find((slot) => slot.key === fromKey);
      if (!dragged || dragged.role === "reference") return;
      event.preventDefault();
      onChange(setVideoSlotRole(slots, fromKey, "reference"));
    },
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2" onDragOver={rowDrop.onDragOver} onDrop={rowDrop.onDrop}>
      {first
        ? <SlotThumb key={first.key} slot={first} slots={slots} onChange={onChange} onRemove={onRemove} drop={slotDrop(first.key)} />
        : <EmptyRoleSlot role="first" onUpload={() => onUpload("first")} drop={roleDrop("first")} />}
      {last
        ? <SlotThumb key={last.key} slot={last} slots={slots} onChange={onChange} onRemove={onRemove} drop={slotDrop(last.key)} />
        : <EmptyRoleSlot role="last" onUpload={() => onUpload("last")} drop={roleDrop("last")} />}
      {references.map((slot) => (
        <SlotThumb key={slot.key} slots={slots} slot={slot} onChange={onChange} onRemove={onRemove} drop={slotDrop(slot.key)} />
      ))}
      {references.length < VIDEO_REFERENCE_MAX ? (
        <span className="flex w-12 flex-col items-center gap-1">
          <ControlButton
            className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:text-foreground"
            onClick={() => onUpload("reference")}
            title={`选择或上传参考图（${references.length}/${VIDEO_REFERENCE_MAX}）`}
            aria-label="选择参考图"
          >
            <Plus className="h-4 w-4" />
          </ControlButton>
          <span className="text-[10px] leading-none text-muted-foreground">参考</span>
        </span>
      ) : null}
    </div>
  );
}
