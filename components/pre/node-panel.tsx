"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fitFloatingRect } from "@/lib/floating-placement";

/** Node controls follow their object while staying inside the canvas viewport. */
export function NodePanel({ left, top, width, children }: { left: number; top: number; width: number; children: ReactNode }) {
  const ref=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:0,height:0,panelHeight:0});
  useLayoutEffect(()=>{
    const el=ref.current,parent=el?.parentElement;if(!el||!parent)return;
    const measure=()=>setSize(previous=>{const next={width:parent.clientWidth,height:parent.clientHeight,panelHeight:el.offsetHeight};return Object.keys(next).every(key=>next[key as keyof typeof next]===previous[key as keyof typeof next])?previous:next;});
    const observer=new ResizeObserver(measure);observer.observe(el);observer.observe(parent);measure();return()=>observer.disconnect();
  },[]);
  const boundedWidth=Math.min(width,Math.max(0,size.width-24));
  // Keep the bottom toolbar and its controls clear as well as the viewport edges.
  const placement=fitFloatingRect(left,top,boundedWidth,size.panelHeight,size.width,size.height-64);
  return <div ref={ref} className="ui-prompt-panel nodrag nowheel nopan absolute z-20 rounded-2xl bg-popover p-3 text-popover-foreground shadow-xl ring-1 ring-foreground/10" style={{...placement,width:boundedWidth,maxHeight:Math.max(0,size.height-88),overflowY:"auto",visibility:size.width?"visible":"hidden"}}>{children}</div>;
}
