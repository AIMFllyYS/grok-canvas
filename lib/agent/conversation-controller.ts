/**
 * Agent 消息窗口与隐藏面板控制（P4-06）。
 * - 历史只渲染最后 50 条，「加载更早」每次多 50 条；窗口按整条消息切，工具调用的输入与结果在同一条消息的 part 里，
 *   不会因为窗口裁剪被拆开误报失败；
 * - 面板隐藏（未打开或不是当前画布）时冻结显示快照：流式 token 继续由 useChat 接收、任务照常运行，
 *   但隐藏的消息列表不随每个 token 重绘；重新可见时立刻同步到最新。
 */
export const MESSAGE_PAGE = 50;

export function windowMessages<T>(messages: readonly T[], shown: number): { items: readonly T[]; hidden: number } {
  const count = Math.max(0, Math.min(messages.length, shown));
  const start = messages.length - count;
  return { items: start === 0 ? messages : messages.slice(start), hidden: start };
}

/** 可见时返回最新值；不可见时返回最后一次可见时的值（首次即不可见则返回当前值）。 */
export function createFreezer<T>() {
  let snapshot: { value: T } | null = null;
  return (value: T, visible: boolean): T => {
    if (visible || !snapshot) snapshot = { value };
    return snapshot.value;
  };
}
