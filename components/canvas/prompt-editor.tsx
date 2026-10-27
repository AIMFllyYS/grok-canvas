"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { fitFloatingRect } from "@/lib/floating-placement";
import { isAssetDrag, readAssetDrag } from "@/lib/asset-drag";
import { insertReferenceToken, referencePattern, referenceToken, type PromptReference } from "@/lib/prompt-references";
import { useEditLease } from "./use-edit-lease";

function serialize(root: Node): string {
  if (root instanceof HTMLElement && root.dataset.asset) return referenceToken(root.dataset.asset);
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  if (root.nodeName === "BR") return "\n";
  // Browsers leave a lone <br> in an emptied contenteditable to host the caret.
  // Actual spaces/newlines are text nodes (including our Enter/paste handlers).
  const children = Array.from(root.childNodes);
  if (children.filter((child) => child.nodeType !== Node.TEXT_NODE || child.textContent !== "").length === 1
    && children.some((child) => child.nodeName === "BR")
    && !root.textContent) return "";
  return children.map((child, index) => {
    const text = serialize(child);
    return index > 0 && (child.nodeName === "DIV" || child.nodeName === "P") ? `\n${text}` : text;
  }).join("");
}

// caretRangeFromPoint 只有 Chromium 系有，其余浏览器回退到标准接口。
type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};
function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as CaretDocument;
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return range;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const fallback = document.createRange();
  fallback.setStart(position.offsetNode, position.offset);
  fallback.collapse(true);
  return fallback;
}

export function PromptEditor({ nodeId, value, references, suggestions = references, readOnly = false, placeholder, badge, sourceLabel, disabledReason, onSelectReference, onBrowse, onCommit, onSubmit }: {
  nodeId: string; value: string; references: PromptReference[]; readOnly?: boolean; placeholder?: string;
  /** @ 下拉项末尾的徽标（如视频参考图的接口编号 #1）；不传则不显示。 */
  badge?: (item: PromptReference, index: number) => string | null;
  suggestions?: PromptReference[];
  sourceLabel?: (item: PromptReference) => string;
  disabledReason?: (item: PromptReference) => string | null;
  onSelectReference?: (item: PromptReference, nextPrompt: string) => boolean;
  onBrowse?: (select: (item: PromptReference) => boolean, close: () => void) => void;
  onCommit: (value: string) => void; onSubmit: (value: string) => void;
}) {
  const lease = useEditLease(nodeId, "prompt");
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const receivedValue = useRef<string | null>(null);
  const trigger = useRef<Range | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(value.length === 0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  // 素材库拖拽经过输入框时高亮，让“能放进来”这件事可见。
  const [dropping, setDropping] = useState(false);
  const options = suggestions.filter((item) => item.name.toLocaleLowerCase().includes((query ?? "").toLocaleLowerCase())).slice(0, 12);
  const reasonFor = (item: PromptReference) => unavailable.has(item.assetName) ? "图片文件不可用" : disabledReason?.(item) ?? null;
  const popupOpen = query !== null && !readOnly;

  useEffect(() => { if (readOnly) setQuery(null); }, [readOnly]);
  useLayoutEffect(() => {
    if (query === null) return;
    const update = () => {
      const root = editor.current;
      if (!root) return;
      const caret = trigger.current?.getBoundingClientRect();
      const rect = caret && (caret.width || caret.height) ? caret : root.getBoundingClientRect();
      const height = Math.min(360, Math.max(92, options.length * 56 + 48));
      const y = rect.bottom + height + 12 < window.innerHeight ? rect.bottom + 8 : rect.top - height - 8;
      setPosition(fitFloatingRect(rect.left, y, 320, height, window.innerWidth, window.innerHeight));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [query, options.length]);
  useEffect(() => {
    if (query !== null) document.getElementById(`reference-${nodeId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, nodeId, query]);

  function chip(assetName: string, selected?: PromptReference) {
    const reference = selected ?? references.find((item) => item.assetName === assetName);
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.asset = assetName;
    span.className = `mx-0.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded px-1.5 align-middle text-sm leading-none ${reference ? "bg-muted" : "bg-destructive/15 text-destructive"}`;
    span.title = reference?.name ?? "引用需更新：图片已移除或已改作其他角色，请修改后再生成";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.removeReference = "true";
    remove.contentEditable = "false";
    remove.setAttribute("aria-label", `删除引用：${reference?.name ?? "失效图片"}`);
    remove.title = "删除引用";
    remove.className = "ui-control inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground";
    remove.textContent = "×";
    if (reference) {
      const img = document.createElement("img");
      img.src = `/api/assets/${assetName}`;
      img.alt = "";
      img.className = "h-4 w-4 shrink-0 rounded object-cover";
      img.draggable = false;
      span.append(img);
    }
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = reference?.name ?? "引用需更新";
    span.append(label, remove);
    return span;
  }

  useEffect(() => {
    const root = editor.current;
    if (!root || composing.current) return;
    const firstRender = receivedValue.current === null;
    const valueChanged = receivedValue.current !== value;
    receivedValue.current = value;
    // Reference-list/local-state renders can still carry the previous store value.
    // Only a new incoming value may hydrate the DOM; an echo of our own input
    // already matches the DOM and must preserve the browser's selection.
    if (valueChanged && serialize(root) !== value) {
      root.replaceChildren();
      let offset = 0;
      for (const match of value.matchAll(referencePattern())) {
        root.append(document.createTextNode(value.slice(offset, match.index)), chip(match[1]!));
        offset = match.index! + match[0].length;
      }
      root.append(document.createTextNode(value.slice(offset)));
    } else {
      root.querySelectorAll<HTMLElement>("[data-asset]").forEach((item) => {
        const next = chip(item.dataset.asset!);
        if (item.title !== next.title || item.className !== next.className) item.replaceWith(next);
      });
    }
    setEmpty(serialize(root).length === 0);
    if (firstRender && !readOnly) {
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [value, references, readOnly]); // Keep ordinary typing outside React's DOM reconciliation.

  function commit() {
    if (!editor.current) return;
    const next = serialize(editor.current);
    setEmpty(next.length === 0);
    onCommit(next);
  }

  function removeChip(tag: HTMLElement) {
    const range = document.createRange();
    range.setStartBefore(tag);
    range.collapse(true);
    tag.remove();
    editor.current?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setQuery(null);
    commit();
  }

  function detect() {
    const selection = window.getSelection();
    if (readOnly || !selection?.isCollapsed || !selection.rangeCount) { setQuery(null); return; }
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE || !editor.current?.contains(range.startContainer)) { setQuery(null); return; }
    const before = range.startContainer.textContent?.slice(0, range.startOffset) ?? "";
    const match = before.match(/@([^@\s]*)$/);
    if (!match) { setQuery(null); return; }
    const replacement = range.cloneRange();
    replacement.setStart(range.startContainer, range.startOffset - match[0].length);
    trigger.current = replacement;
    setQuery(match[1]!);
    setActive(0);
  }

  function choose(item: PromptReference): boolean {
    const range = trigger.current, root = editor.current;
    if (readOnly || reasonFor(item) || !root?.isConnected || !range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
    const before = document.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange(); after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
    const nextPrompt = serialize(before.cloneContents()) + referenceToken(item.assetName) + " " + serialize(after.cloneContents());
    if (onSelectReference && !onSelectReference(item, nextPrompt)) return false;
    range.deleteContents();
    const tag = chip(item.assetName, item);
    range.insertNode(tag);
    const space = document.createTextNode(" ");
    tag.after(space);
    range.setStart(space, 1);
    range.collapse(true);
    root.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setQuery(null);
    setEmpty(false);
    if (!onSelectReference) onCommit(nextPrompt);
    return true;
  }

  function browse() {
    const root = editor.current;
    if (!root || !onBrowse || readOnly) return;
    const original = serialize(root);
    const range = trigger.current?.cloneRange();
    setQuery(null);
    onBrowse(item => {
      if (!root.isConnected || serialize(root) !== original || !range) return false;
      trigger.current = range;
      return choose(item);
    }, () => requestAnimationFrame(() => {
      if (!root.isConnected) return;
      root.focus({ preventScroll: true });
      const next = trigger.current;
      if (next && root.contains(next.startContainer)) {
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(next);
      }
    }));
  }

  /** 落点换算成序列化文本里的偏移；点在编辑器外时追加到末尾。 */
  function dropOffset(root: HTMLElement, x: number, y: number): number {
    const caret = caretRangeAt(x, y);
    if (!caret || !root.contains(caret.startContainer)) return serialize(root).length;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(caret.startContainer, caret.startOffset);
    return serialize(before.cloneContents()).length;
  }

  /** 把素材拖进输入框：效果与在 @ 候选里选中同一张图完全一致。 */
  function dropReference(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDropping(false);
    const root = editor.current;
    if (readOnly || !root) return;
    const assetName = readAssetDrag(event.dataTransfer);
    if (!assetName) return;
    const item = suggestions.find((option) => option.assetName === assetName)
      ?? references.find((option) => option.assetName === assetName);
    if (!item) return;
    const prompt = insertReferenceToken(serialize(root), assetName, dropOffset(root, event.clientX, event.clientY));
    if (onSelectReference && !onSelectReference(item, prompt)) return;
    if (!onSelectReference) onCommit(prompt);
    setQuery(null);
    requestAnimationFrame(() => {
      if (!root.isConnected) return;
      root.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  }

  return <div className="relative">
    {empty && <div className="pointer-events-none absolute left-1 top-2 text-base text-muted-foreground">
      {dropping ? "松开即可引用这张图片" : placeholder ?? "描述你想生成的画面，输入 @ 引用画布素材"}
    </div>}
    <div ref={editor} contentEditable={!readOnly} aria-readonly={readOnly || undefined} suppressContentEditableWarning role="textbox" aria-label="生成描述" aria-multiline="true"
      onFocus={lease.onFocus}
      aria-expanded={popupOpen} aria-controls={popupOpen ? `references-${nodeId}` : undefined}
      aria-activedescendant={popupOpen && (options[active] || (onBrowse && active === options.length)) ? `reference-${nodeId}-${active}` : undefined}
      className={`ui-prompt-editor max-h-60 min-h-24 overflow-y-auto whitespace-pre-wrap break-words px-1 py-2 text-base outline-none ${dropping ? "bg-accent/40 ring-1 ring-inset ring-foreground/30" : ""}`}
      onCompositionStart={() => { composing.current = true; setQuery(null); }}
      onDragOver={(event) => {
        if (readOnly || !isAssetDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!dropping) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={dropReference}
      onCompositionEnd={() => { composing.current = false; commit(); detect(); }}
      onInput={() => {
        if (readOnly) return;
        if (editor.current) setEmpty(serialize(editor.current).length === 0);
        if (!composing.current) { commit(); detect(); }
      }}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-remove-reference]")) event.preventDefault();
      }}
      onClick={(event) => {
        if (readOnly) return;
        const button = (event.target as HTMLElement).closest("[data-remove-reference]");
        const tag = button?.closest<HTMLElement>("[data-asset]");
        if (tag) { event.preventDefault(); event.stopPropagation(); removeChip(tag); }
        else detect();
      }}
      onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && !composing.current) detect(); }}
      onBlur={() => { setQuery(null); lease.onBlur(); }}
      onPaste={(event) => {
        event.preventDefault();
        if (readOnly) return;
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const text = document.createTextNode(event.clipboardData.getData("text/plain"));
        range.insertNode(text); range.setStartAfter(text); range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range); commit(); detect();
      }}
      onKeyDown={(event) => {
        if (readOnly || event.nativeEvent.isComposing || composing.current) return;
        if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const selection = window.getSelection();
          if (selection?.isCollapsed && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const container = range.startContainer;
            const backwards = event.key === "Backspace";
            let adjacent: Node | null = null;
            if (container.nodeType === Node.TEXT_NODE) {
              if (backwards && range.startOffset === 0) adjacent = container.previousSibling;
              if (!backwards && range.startOffset === (container.textContent?.length ?? 0)) adjacent = container.nextSibling;
            } else {
              adjacent = container.childNodes[range.startOffset - (backwards ? 1 : 0)] ?? null;
            }
            while (adjacent?.nodeType === Node.TEXT_NODE && !adjacent.textContent) {
              adjacent = backwards ? adjacent.previousSibling : adjacent.nextSibling;
            }
            if (adjacent instanceof HTMLElement && adjacent.dataset.asset) {
              event.preventDefault(); removeChip(adjacent); return;
            }
          }
        }
        if (query !== null) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(null); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const total = options.length + (onBrowse ? 1 : 0);
            setActive(index => {
              if (!total) return 0;
              let next = index;
              for (let count = 0; count < total; count++) { next = (next + (event.key === "ArrowDown" ? 1 : -1) + total) % total; if (next === options.length || !reasonFor(options[next]!)) break; }
              return next;
            }); return;
          }
          if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (options[active]) { event.preventDefault(); choose(options[active]!); return; }
            if (active === options.length && onBrowse) { event.preventDefault(); browse(); return; }
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commit(); onSubmit(editor.current ? serialize(editor.current) : value); return; }
        if (event.key === "Enter") {
          event.preventDefault();
          const selection = window.getSelection();
          if (!selection?.rangeCount) return;
          const range = selection.getRangeAt(0); range.deleteContents();
          const text = document.createTextNode("\n"); range.insertNode(text); range.setStartAfter(text); range.collapse(true);
          selection.removeAllRanges(); selection.addRange(range); commit();
        }
      }} />
    {popupOpen && createPortal(<div id={`references-${nodeId}`} role="listbox" aria-label="选择画布参考图" data-workspace-overlay style={position} className="fixed z-[80] max-h-[min(360px,80vh)] w-80 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      {options.length ? options.map((item, index) => {
        const reason = reasonFor(item);
        const bound = references.some(reference => reference.assetName === item.assetName);
        return <button key={item.assetName} id={`reference-${nodeId}-${index}`} type="button" role="option" aria-selected={index === active} aria-disabled={Boolean(reason)} title={reason ?? item.name}
          className={`ui-control flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm aria-disabled:opacity-40 ${index === active ? "bg-accent" : "hover:bg-accent"}`}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(item)}>
          <img src={`/api/assets/${encodeURIComponent(item.assetName)}`} alt="" className="h-9 w-9 shrink-0 rounded object-cover" onError={() => setUnavailable(current => new Set(current).add(item.assetName))} />
          <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span><span className="block truncate text-[10px] text-muted-foreground">{reason ?? sourceLabel?.(item) ?? (bound ? "已添加" : "画布素材")}</span></span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{bound ? badge?.(item, index) ?? "已添加" : "+ 参考"}</span>
        </button>;
      }) : <p className="p-3 text-xs text-muted-foreground">没有匹配的图片，可打开素材库上传</p>}
      {onBrowse && <button id={`reference-${nodeId}-${options.length}`} role="option" aria-selected={active === options.length} type="button" className={`ui-control mt-1 w-full rounded-lg border-t px-3 py-2 text-left text-xs text-muted-foreground ${active === options.length ? "bg-accent" : ""}`} onMouseDown={event => event.preventDefault()} onClick={browse}>浏览素材库 / 上传图片…</button>}
    </div>, document.body)}
  </div>;
}
