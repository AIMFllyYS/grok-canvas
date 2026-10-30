type NodeView = { id: string; data: unknown; selected?: boolean; draggable?: boolean };

/** 仅适用于消费这四个属性的节点内容；几何由 React Flow 外壳管理。 */
export function sameNodeView(a: NodeView, b: NodeView): boolean {
  return a.id === b.id && a.data === b.data && a.selected === b.selected && a.draggable === b.draggable;
}

type ZoomState = { transform: [number, number, number] };
type ZoomStore = { getState(): ZoomState; subscribe(listener: (state: ZoomState) => void): () => void };
type ZoomStyle = Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;

/** 一个画布一个订阅，缩放只更新继承样式，不驱动所有节点重渲染。 */
export function bindCanvasZoom(store: ZoomStore, style: ZoomStyle): () => void {
  let previous = NaN;
  const update = ({ transform }: ZoomState) => {
    const zoom = Number.isFinite(transform[2]) ? Math.max(0.1, transform[2]) : 1;
    if (zoom === previous) return;
    previous = zoom;
    style.setProperty("--selection-width", `${2 / zoom}px`);
    style.setProperty("--canvas-inverse-zoom", String(1 / zoom));
  };
  const unsubscribe = store.subscribe(update);
  update(store.getState());
  return () => {
    unsubscribe();
    style.removeProperty("--selection-width");
    style.removeProperty("--canvas-inverse-zoom");
  };
}
