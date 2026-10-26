"use client";
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Plus, ImagePlus, Video, FileText, SlidersHorizontal } from "lucide-react";
import { FloatingMenu, MenuItem } from "@/components/ui/floating-menu";
import { WorkButton } from "./primitives";
export function NodeAddMenu({ onAdd }: { onAdd: (type: "image" | "video" | "text" | "prompt") => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [open]);
  return <div ref={ref} className="pre-add-menu"><WorkButton variant="ghost" aria-label="添加节点" aria-expanded={open} onClick={e => { const r=e.currentTarget.getBoundingClientRect(); setAnchor({x:r.left,y:r.top>180?r.top-154:r.bottom+8}); setOpen(!open); }}><Plus size={17}/></WorkButton>{open && createPortal(<div ref={menu}><FloatingMenu position={anchor} className="pre-node-add-popup" onClose={() => setOpen(false)}>{([['image','图片',ImagePlus],['video','视频',Video],['text','文本',FileText],['prompt','提示词参数',SlidersHorizontal]] as const).map(([id,label,Icon]) => <MenuItem key={id} icon={<Icon size={14}/>} label={`添加${label}节点`} onClick={() => { onAdd(id); setOpen(false); }}/>)}</FloatingMenu></div>,document.body)}</div>;
}
