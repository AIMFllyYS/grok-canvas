export type InteractionMode = "select" | "hand";
/**
 * 手型与选择唯一的区别就是空白处按左键的手势：选择模式框选，手型模式直接平移。
 * 其余节点交互（拖动、选中、弹出面板、连线）两种模式完全一致。
 */
export function interactionConfig(mode: InteractionMode) {
  const selecting = mode === "select";
  return { selectionOnDrag: selecting, panOnDrag: selecting ? [1, 2] : [0, 1, 2], nodesDraggable: true, nodesConnectable: true, elementsSelectable: true };
}
export function interactionShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }, editing = false): InteractionMode | null {
  if (editing || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  return event.key.toLowerCase() === "v" ? "select" : event.key.toLowerCase() === "h" ? "hand" : null;
}
