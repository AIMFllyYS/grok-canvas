"use client";

import { ControlButton } from "@/components/ui/control-button";

import { useState } from "react";
import { PopoverSurface } from "@/components/ui/popover-surface";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronsUpDown, Plus, Search, Trash2 } from "lucide-react";
import type { CanvasDoc, CanvasSummary } from "@/lib/canvas-store";
import { useDesktopAvailable } from "@/components/desktop-workspace";

export function CanvasSwitcher({
  doc,
  canvases,
  onSwitch,
  onCreate,
  onDelete,
  onRename,
}: {
  doc: CanvasDoc;
  canvases: CanvasSummary[];
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const available = useDesktopAvailable();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? canvases.filter((item) => item.name.toLowerCase().includes(keyword))
    : canvases;

  return (
    // 宽度上限由顶栏（page.tsx）统一控制，这里只负责在可用宽度里收缩。
    <div className="flex min-w-0 items-center gap-0.5">
      {editing ? (
        <input
          autoFocus
          aria-label="画布名称"
          defaultValue={doc.name}
          className="rounded-sm bg-transparent px-1 py-0.5 text-sm font-medium outline-none ring-1 ring-primary"
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value && value !== doc.name) {
              onRename(value);
            }
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      ) : (
        <ControlButton
          className="truncate rounded-sm px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
          onDoubleClick={() => setEditing(true)}
          onKeyDown={event => { if (["Enter", " ", "F2"].includes(event.key)) { event.preventDefault(); setEditing(true); } }}
          title="双击，或按 Enter、空格、F2 重命名"
        >
          {doc.name}
        </ControlButton>
      )}

      <Popover.Root
        open={available && open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setConfirmDeleteId(null);
          }
        }}
      >
        <Popover.Trigger data-ui-control="true"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="切换画布"
        >
          <ChevronsUpDown className="h-4 w-4" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} className="isolate z-50 outline-none">
            <PopoverSurface className="w-64 p-1.5">
              <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="搜索画布"
                  placeholder="搜索画布"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="mt-1 max-h-80 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">未找到画布</p>
                ) : (
                  filtered.map((item) => (
                    <div key={item.id} data-selected={item.id === doc.id} className="ui-list-row group flex w-full items-center rounded-md hover:bg-accent">
                      <ControlButton
                        type="button"
                        aria-current={item.id === doc.id ? "true" : undefined}
                        onClick={() => {
                          setOpen(false);
                          if (item.id !== doc.id) {
                            onSwitch(item.id);
                          }
                        }}
                        className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm ${
                          item.id === doc.id ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        <span className="flex w-4 shrink-0 items-center">
                          {item.id === doc.id ? <Check className="h-4 w-4" /> : null}
                        </span>
                        <span className="truncate">{item.name}</span>
                      </ControlButton>
                      {confirmDeleteId === item.id ? (
                        <ControlButton
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDelete(item.id);
                          }}
                          data-danger="true"
                          className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          确认删除
                        </ControlButton>
                      ) : (
                        <ControlButton
                          type="button"
                          data-danger="true"
                          title="删除画布"
                          aria-label={`删除画布：${item.name}`}
                          onClick={() => setConfirmDeleteId(item.id)}
                          className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex group-focus-within:flex"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </ControlButton>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="mt-1 border-t pt-1">
                <ControlButton
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onCreate();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Plus className="h-4 w-4" />
                  新建画布
                </ControlButton>
              </div>
            </PopoverSurface>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
