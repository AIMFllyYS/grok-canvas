import { loadProject } from "./store";
import { produce, type ProductionAction } from "./production";
import { isScriptApproved } from "./schema";
type BatchStage = "reference" | "storyboard" | "video" | "all";
export type BatchProgress = {
  stage: string;
  targetId?: string;
  completed: number;
  failed: Array<{ id: string; error: string }>;
  finished: boolean;
  stopped?: boolean;
  message?: string;
};

/** A single SDK tool can advance long projects without one model turn per image. */
export async function* runProductionBatch(
  projectId: string,
  stage: BatchStage,
  signal?: AbortSignal,
  deps = { load: loadProject, produce },
): AsyncGenerator<BatchProgress> {
  let completed = 0;
  const failed: BatchProgress["failed"] = [],
    started = Date.now();
  let p = await deps.load(projectId);
  if (!p.script) {
    if (stage !== "all") {
      yield {
        stage,
        completed,
        failed,
        finished: true,
        message: "请先生成导演脚本",
      };
      return;
    }
    await deps.produce(projectId, "script", {}, signal);
    completed++;
    yield { stage: "script", completed, failed: [...failed], finished: false };
  }
  p = await deps.load(projectId);
  if (!isScriptApproved(p)) {
    yield { stage: "approval", completed, failed, finished: true, message: "脚本已准备好。请在导演台审阅并确认批准，再继续批量制作。" };
    return;
  }
  for (const current of stage === "all"
    ? (["reference", "storyboard", "video"] as const)
    : [stage]) {
    p = await deps.load(projectId);
    const ids =
      current === "reference"
        ? p.references.filter((r) => !r.assetName).map((r) => r.id)
        : p.shots
            .filter((s) =>
              current === "storyboard"
                ? !s.imageAsset
                : !s.videoAsset && !s.taskId,
            )
            .map((s) => s.id);
    for (const targetId of ids) {
      if (signal?.aborted || Date.now() - started > 540000) {
        yield {
          stage: current,
          completed,
          failed: [...failed],
          finished: true,
          stopped: true,
          message: "当前批次已停止；已完成结果保留，继续时仅补齐缺失项。",
        };
        return;
      }
      yield {
        stage: current,
        targetId,
        completed,
        failed: [...failed],
        finished: false,
      };
      try {
        await deps.produce(
          projectId,
          current as ProductionAction,
          { targetId },
          signal,
        );
        completed++;
      } catch (error) {
        failed.push({
          id: `${current}:${targetId}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      yield {
        stage: current,
        targetId,
        completed,
        failed: [...failed],
        finished: false,
      };
    }
  }
  yield {
    stage,
    completed,
    failed,
    finished: true,
    message:
      "制作任务已提交或完成。视频会继续恢复查询；成片合成前需要逐镜验收。",
  };
}
