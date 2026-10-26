"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Film,
  ImagePlus,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Clapperboard,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  exportSignature,
  shotPrompt,
  timeline,
  type Shot,
  type StudioProject,
} from "@/lib/studio/schema";
import type { ActionInput, ProductionAction } from "@/lib/studio/production";
import { ShotEditor } from "./shot-editor";
import { ResizeGrip } from "./edge-panel";
import { ScriptReview } from "@/components/pre/script-review";
import { FileChip } from "@/components/pre/primitives";
import { MediaPreview } from "@/components/pre/media-preview";

export type DeskProps = {
  project: StudioProject;
  busy: boolean;
  pending: string;
  onAction: (action: ProductionAction, input?: ActionInput) => Promise<void>;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onBatch: (
    stage: "reference" | "storyboard" | "video" | "all",
  ) => Promise<void>;
  onUpload: () => void;
  view: DeskView;
  onViewChange: (view: DeskView) => void;
};
export type DeskView = "brief" | "script" | "refs" | "shots" | "archive";
export function DirectorDesk(props: DeskProps) {
  const {
    project: p,
    busy,
    pending,
    onAction,
    onPatch,
    onBatch,
    onUpload,
  } = props;
  const tab = props.view, setTab = props.onViewChange;
  const [listWidth, setListWidth] = useState(210);
  const [selected, setSelected] = useState(p.shots[0]?.id ?? "");
  useEffect(() => {
    if (p.shots.length && !selected) {
      setSelected(p.shots[0]!.id);
      setTab("script");
    }
  }, [p.shots, selected]);
  const shots = timeline(p.shots),
    shot = p.shots.find((s) => s.id === selected) ?? p.shots[0];
  const complete = p.shots.filter((s) => s.videoApproved).length;
  return (
    <section className="studio-director" style={{ "--shot-list-width": `${listWidth}px` } as CSSProperties}>
      {tab === "brief" ? (
        <BriefEditor key={p.id} {...props} />
      ) : tab === "script" ? (
        <div className="studio-script-view">
          <div className="studio-section-line">
            <span className="studio-eyebrow">THE COMPLETE DIRECTOR SCRIPT</span>
            <div>
              <button
                className="studio-button-quiet"
                disabled={!p.script}
                onClick={() => void copy(p.script)}
              >
                <Copy size={14} />
                复制脚本
              </button>
              <button
                className="studio-button-quiet"
                disabled={busy}
                onClick={() => void onAction("script", { force: !!p.script })}
              >
                <RefreshCw size={14} />
                {p.script ? "重写脚本" : "生成脚本"}
              </button>
            </div>
          </div>
          {p.script ? (
            <ScriptReview project={p} busy={busy} onSave={onPatch} onApprove={async () => { await onPatch({ approveScript: true }); setTab("refs"); await onBatch("reference"); }}/>
          ) : (
            <EmptyState
              title="暂无剧本"
              text="先填写创作简报，Agent 会为你组织完整的导演脚本。"
              onClick={() => setTab("brief")}
              label="填写创作简报"
            />
          )}
        </div>
      ) : tab === "refs" ? (
        <div className="studio-references-view">
          <div className="studio-section-line">
            <div>
              <span className="studio-eyebrow">REFERENCE BIBLE</span>
              <h2>参考素材</h2>
            </div>
            <button
              className="studio-button"
              disabled={busy || !p.references.length}
              onClick={() => void onBatch("reference")}
            >
              <ImagePlus size={14} />
              生成缺失参考图
            </button>
          </div>
          <div className="studio-reference-grid">
            {p.references.map((ref) => (
              <article className="studio-reference-card" key={ref.id}>
                <div className="studio-reference-image">
                  {ref.assetName ? (
                    <MediaPreview assetName={ref.assetName} name={ref.name}/>
                  ) : (
                    <>
                      <ImagePlus size={25} />
                      <span>等待生成参考图</span>
                    </>
                  )}
                  <span className="studio-ref-tag">@{ref.id}</span>
                  {ref.approved && (
                    <span className="studio-approved">
                      <Check size={12} />
                      已验收
                    </span>
                  )}
                </div>
                <div>
                  <span className="studio-eyebrow">{ref.group}</span>
                  <h3>{ref.name}</h3>
                  <p>{ref.description}</p>
                  {ref.error && (
                    <p className="studio-error" role="alert">
                      {ref.error}
                    </p>
                  )}
                  <details>
                    <summary>查看生成提示词</summary>
                    <MessageResponse mode="static">
                      {ref.prompt.zh}
                    </MessageResponse>
                    <MessageResponse mode="static">{ref.prompt.en}</MessageResponse>
                  </details>
                  <div className="studio-card-actions">
                    <button
                      className="studio-button-quiet"
                      disabled={busy || !!ref.approved}
                      onClick={() =>
                        void onAction("reference", {
                          targetId: ref.id,
                          force: !!ref.assetName,
                        })
                      }
                    >
                      {pending === `reference:${ref.id}` ? (
                        <LoaderCircle className="animate-spin" size={13} />
                      ) : (
                        <RefreshCw size={13} />
                      )}{" "}
                      {ref.assetName
                        ? "重新生成"
                        : ref.error?.includes("保存")
                          ? "恢复图片保存"
                          : "生成参考图"}
                    </button>
                    {ref.assetName && (
                      <button
                        className="studio-button-quiet"
                        disabled={busy}
                        onClick={() =>
                          void onPatch({
                            referenceApproval: {
                              id: ref.id,
                              approved: !ref.approved,
                            },
                          })
                        }
                      >
                        <Check size={14} />
                        {ref.approved ? "撤销验收" : "验收通过"}
                      </button>
                    )}
                  </div>
                  {!ref.assetName && ref.error?.includes("确认") && (
                    <button
                      className="studio-button-quiet"
                      disabled={busy}
                      onClick={() =>
                        void onAction("reference", {
                          targetId: ref.id,
                          force: true,
                        })
                      }
                    >
                      确认重新发起生成
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!p.references.length && (
            <EmptyState
              title="让角色与场景保持一致"
              text="生成脚本后，这里会建立角色、场景和道具的固定参考库。"
              onClick={() => setTab("brief")}
              label="开始规划"
            />
          )}
        </div>
      ) : tab === "archive" ? (
        <div className="studio-archive">
          <div className="studio-section-line">
            <div>
              <h2>
                已验收 {complete} / {p.shots.length} 个镜头
              </h2>
            </div>
            <button
              className="studio-button"
              disabled={busy || !p.shots.length || complete !== p.shots.length}
              onClick={() => void onAction("export")}
            >
              <Film size={15} />
              {pending === "export:" ? "正在合成…" : "合成完整 MP4"}
            </button>
          </div>
          {p.exportAsset && p.exportSignature === exportSignature(p) && (
            <div className="studio-final-film">
              <video controls src={`/api/assets/${p.exportAsset}`} />
              <a
                className="studio-button"
                href={`/api/assets/${p.exportAsset}`}
                download={`${p.title}.mp4`}
              >
                <Download size={15} />
                下载完整视频
              </a>
              <p>无声画面版 · 旁白与字幕可在后期单独制作</p>
            </div>
          )}
          <div className="studio-reference-grid">
            {p.shots
              .filter((s) => s.videoApproved)
              .map((s) => (
                <article className="studio-reference-card" key={s.id}>
                  <video controls src={`/api/assets/${s.videoAsset}`} />
                  <div>
                    <span className="studio-eyebrow">
                      {s.id} / {s.duration}s
                    </span>
                    <h3>{s.title}</h3>
                    <button
                      className="studio-button-quiet"
                      disabled={busy}
                      onClick={() =>
                        void onAction("review", {
                          targetId: s.id,
                          kind: "video",
                          approved: false,
                        })
                      }
                    >
                      撤销验收
                    </button>
                  </div>
                </article>
              ))}
          </div>
          {!complete && (
            <EmptyState
              title="暂无已验收镜头"
              text="在分镜制作中逐一检查画面与动作，验收通过的视频会收录在这里。"
              onClick={() => setTab("shots")}
              label="前往分镜制作"
            />
          )}
        </div>
      ) : (
        <>
          <div className="studio-timeline-strip" aria-label="影片分镜时间线">
            {shots.map((s) => (
              <button
                key={s.id}
                style={{ flexGrow: s.duration }}
                data-selected={s.id === shot?.id}
                data-completed={!!s.videoApproved}
                onClick={() => setSelected(s.id)}
              >
                <span>{s.id}</span>
                <small>
                  {s.timelineStart}–{s.timelineEnd}s
                </small>
                <i />
              </button>
            ))}
            {!shots.length && (
              <span>生成脚本后，你的镜头将在这里排成时间线。</span>
            )}
          </div>
          {shot ? (
            <div className="studio-shot-workspace">
              <aside className="studio-shot-list">
                <div className="studio-section-line">
                  <span className="studio-eyebrow">镜头</span>
                  <span>{p.shots.length}</span>
                </div>
                {shots.map((s) => (
                  <button
                    key={s.id}
                    data-selected={s.id === shot.id}
                    onClick={() => setSelected(s.id)}
                  >
                    <div className="studio-shot-thumb">
                      {s.imageAsset ? (
                        <img src={`/api/assets/${s.imageAsset}`} alt="" />
                      ) : (
                        <Film size={17} />
                      )}
                    </div>
                    <span>
                      <small>
                        {s.id} · {s.timelineStart}–{s.timelineEnd}s
                      </small>
                      <strong>{s.title}</strong>
                      <em>
                        {s.videoApproved
                          ? "视频已验收"
                          : s.taskId
                            ? "视频生成中"
                            : s.videoAsset
                              ? "视频待验收"
                              : s.imageApproved
                                ? "分镜已验收"
                                : s.imageAsset
                                  ? "分镜待验收"
                                  : "待制作"}
                      </em>
                    </span>
                    {s.videoApproved && <Check size={13} />}
                  </button>
                ))}
              </aside>
              <ResizeGrip name="调整镜头列表宽度" storageKey="studio-shot-list-width" initial={210} min={150} max={320} onWidth={setListWidth} />
              <ShotDetail key={shot.id} shot={shot} {...props} />
            </div>
          ) : (
            <EmptyState
              title="暂无分镜"
              text="导演脚本将被组织为连续片段，明确动作节拍、参考素材和运镜。"
              onClick={() => setTab("brief")}
              label="创建分镜计划"
            />
          )}
        </>
      )}
    </section>
  );
}

function BriefEditor({
  project: p,
  busy,
  pending,
  onPatch,
  onAction,
  onUpload,
}: DeskProps) {
  const initial = useMemo(() => {
    try {
      const value = localStorage.getItem(`studio-brief-draft-${p.id}`);
      return value
        ? (JSON.parse(value) as Partial<
            Pick<
              StudioProject,
              | "brief"
              | "title"
              | "aspect"
              | "targetDuration"
              | "style"
              | "negative"
            >
          >)
        : {};
    } catch {
      return {};
    }
  }, [p.id]);
  const [brief, setBrief] = useState(initial.brief ?? p.brief),
    [title, setTitle] = useState(initial.title ?? p.title),
    [aspect, setAspect] = useState(initial.aspect ?? p.aspect),
    [duration, setDuration] = useState(
      initial.targetDuration ?? p.targetDuration,
    ),
    [style, setStyle] = useState(initial.style ?? p.style),
    [negative, setNegative] = useState(initial.negative ?? p.negative);
  const dirty =
    brief !== p.brief ||
    title !== p.title ||
    aspect !== p.aspect ||
    duration !== p.targetDuration ||
    JSON.stringify(style) !== JSON.stringify(p.style) ||
    JSON.stringify(negative) !== JSON.stringify(p.negative);
  useEffect(() => {
    try {
      const key = `studio-brief-draft-${p.id}`;
      if (dirty)
        localStorage.setItem(
          key,
          JSON.stringify({
            brief,
            title,
            aspect,
            targetDuration: duration,
            style,
            negative,
          }),
        );
      else localStorage.removeItem(key);
    } catch {}
  }, [p.id, dirty, brief, title, aspect, duration, style, negative]);
  const save = async () => {
    await onPatch({
      brief,
      title,
      aspect,
      targetDuration: duration,
      style,
      negative,
    });
    try {
      localStorage.removeItem(`studio-brief-draft-${p.id}`);
    } catch {}
  };
  return (
    <div className="studio-brief-layout">
      <div className="studio-brief-main">
        <span className="studio-eyebrow">01 / THE CREATIVE BRIEF</span>
        {dirty && (
          <span className="studio-draft-label">
            草稿已在本机保留 · 点击保存后用于生成
          </span>
        )}
        <h2>创作简报</h2>
        <p>放入灵感、原始文稿或创作要求。角色、情节与画面，会从这里生长。</p>
        <label>
          作品名称
          <input
            aria-label="作品名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
          />
        </label>
        <label>
          创作简报
          <textarea
            aria-label="创作简报"
            className="studio-brief-textarea"
            placeholder="故事是什么？希望观众看完有什么感受？也可以直接粘贴原始素材…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
        <div className="studio-form-row">
          <label>
            画面比例
            <select
              aria-label="画面比例"
              value={aspect}
              onChange={(e) => setAspect(e.target.value as typeof aspect)}
            >
              <option value="16:9">16:9 横屏</option>
              <option value="9:16">9:16 竖屏</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </label>
          <label>
            目标时长（秒）
            <input
              aria-label="目标时长（秒）"
              type="number"
              min="6"
              max="600"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
        </div>
        <details className="studio-style-settings">
          <summary>
            全片风格与负面提示词 <span>每个镜头统一继承</span>
          </summary>
          <label>
            风格 · 中文
            <textarea
              value={style.zh}
              onChange={(e) => setStyle({ ...style, zh: e.target.value })}
            />
          </label>
          <label>
            风格 · English
            <textarea
              value={style.en}
              onChange={(e) => setStyle({ ...style, en: e.target.value })}
            />
          </label>
          <label>
            负面提示词 · 中文
            <textarea
              value={negative.zh}
              onChange={(e) => setNegative({ ...negative, zh: e.target.value })}
            />
          </label>
          <label>
            负面提示词 · English
            <textarea
              value={negative.en}
              onChange={(e) => setNegative({ ...negative, en: e.target.value })}
            />
          </label>
        </details>
        <div className="studio-brief-actions">
          <button
            className="studio-button-quiet"
            disabled={busy}
            onClick={() => void save()}
          >
            <Save size={15} />
            保存简报
          </button>
          <button
            className="studio-button"
            disabled={busy || (!brief.trim() && !p.sources.length)}
            onClick={async () => {
              try {
                await save();
                await onAction("script", { force: !!p.script });
              } catch {}
            }}
          >
            {pending.startsWith("script") ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <Clapperboard size={15} />
            )}{" "}
            {pending.startsWith("script") ? "正在生成脚本…" : p.script ? "更新导演脚本" : "生成导演脚本"}
          </button>
        </div>
      </div>
      <aside className="studio-source-library">
        <div className="studio-section-line">
          <span className="studio-eyebrow">创作素材</span>
          <button
            className="studio-icon-button"
            aria-label="添加素材"
            onClick={onUpload}
            disabled={busy}
          >
            <ImagePlus size={16} />
          </button>
        </div>
        <h3>创作素材</h3>
        <p>图片用于视觉参考，文字用于理解故事。每份素材都保留来源。</p>
        {p.sources.map((s) => (
          <div className="studio-source-item" key={s.id}>
            {s.frames?.[0]?.assetName || (s.assetName && s.kind === "image") ? (
              <img
                src={`/api/assets/${s.frames?.[0]?.assetName ?? s.assetName}`}
                alt={s.name}
              />
            ) : (
              <FileText size={20} />
            )}
            <span>
              <strong>{s.name}</strong>
              <small>
                {s.kind === "text"
                  ? `${s.text.length} 字`
                  : s.text
                    ? "已分析图片"
                    : "图片 · 等待分析"}
              </small>
            </span>
            <button
              aria-label={`移除素材 ${s.name}`}
              className="studio-icon-button"
              disabled={busy}
              onClick={() => void onPatch({ removeSource: s.id })}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          className="studio-upload-zone"
          onClick={onUpload}
          disabled={busy}
        >
          <ImagePlus size={25} />
          <strong>添加创作素材</strong>
          <span>图片 / MP4 / TXT / Markdown</span>
        </button>
        <div className="studio-brief-note">
          <span>导演笔记</span>
          <p>
            清楚的动作比堆叠形容词更有用。写下“谁在几秒内，做了什么”，剩下的交给镜头。
          </p>
        </div>
      </aside>
    </div>
  );
}

function ShotDetail({
  shot: s,
  project: p,
  busy,
  pending,
  onAction,
  onPatch,
}: DeskProps & { shot: Shot }) {
  const [lang, setLang] = useState<"zh" | "en">("zh"),
    [media, setMedia] = useState<"image" | "video">("image"),
    [feedback, setFeedback] = useState(s.feedback ?? ""),
    [editing, setEditing] = useState(false);
  const start =
    timeline(p.shots).find((t) => t.id === s.id)?.timelineStart ?? 0;
  const prompt = shotPrompt(p, s, lang);
  const edit = () => {
    setEditing(true);
  };
  return (
    <>
      <section className="studio-shot-center">
        <div className="studio-shot-heading">
          <span className="studio-eyebrow">
            {s.id} / {String(start).padStart(2, "0")}–
            {String(start + s.duration).padStart(2, "0")} SEC
          </span>
          <h2>{s.title}</h2>
          <p>{s.scene}</p>
        </div>
        <div className="studio-preview-tabs">
          <button
            data-active={media === "image"}
            onClick={() => setMedia("image")}
          >
            <ImagePlus size={13} />
            分镜图
          </button>
          <button
            data-active={media === "video"}
            onClick={() => setMedia("video")}
          >
            <Play size={13} />
            视频
          </button>
          <span>
            {media === "image"
              ? s.imageApproved
                ? "已验收"
                : s.imageAsset
                  ? "待验收"
                  : "待生成"
              : s.videoApproved
                ? "已验收"
                : s.taskId
                  ? "生成中"
                  : s.videoAsset
                    ? "待验收"
                    : "待生成"}
          </span>
        </div>
        <div
          className="studio-shot-preview"
          style={{ aspectRatio: p.aspect.replace(":", "/") }}
        >
          {media === "video" && s.videoAsset ? (
            <video
              controls
              key={s.videoAsset}
              src={`/api/assets/${s.videoAsset}`}
              poster={s.imageAsset ? `/api/assets/${s.imageAsset}` : undefined}
            />
          ) : media === "image" && s.imageAsset ? (
            <img
              src={`/api/assets/${s.imageAsset}`}
              alt={`${s.id} ${s.title}`}
            />
          ) : (
            <div>
              {s.taskId && media === "video" ? (
                <LoaderCircle size={32} className="animate-spin" />
              ) : (
                <ClapFrame />
              )}
              <strong>
                {s.taskId && media === "video"
                  ? "镜头正在生成"
                  : "等待你的第一个画面"}
              </strong>
              <span>
                {media === "image"
                  ? "固定参考、构图与风格，生成这一镜的首帧。"
                  : "从分镜首帧出发，让动作按时间发生。"}
              </span>
            </div>
          )}
        </div>
        {s.error && (
          <p className="studio-error" role="alert">
            {s.error}
          </p>
        )}
        <div className="studio-review-bar">
          <span>
            {media === "image"
              ? "检查角色、构图与风格一致性"
              : "检查动作节拍、连续性与画面稳定性"}
          </span>
          <button
            className="studio-button-quiet"
            disabled={
              busy || !(media === "image" ? s.imageAsset : s.videoAsset)
            }
            onClick={() =>
              void onAction("review", {
                targetId: s.id,
                kind: media,
                approved: !(media === "image"
                  ? s.imageApproved
                  : s.videoApproved),
                feedback,
              })
            }
          >
            <Check size={14} />
            {(media === "image" ? s.imageApproved : s.videoApproved)
              ? "撤销验收"
              : "验收通过"}
          </button>
        </div>
        <div className="studio-beats">
          <div className="studio-section-line">
            <span className="studio-eyebrow">动作节拍</span>
            <button
              className="studio-button-quiet"
              disabled={busy || !!s.videoApproved}
              onClick={edit}
            >
              编辑镜头
            </button>
          </div>
          {s.beats.map((beat, i) => (
            <div className="studio-beat" key={i}>
              <span>
                {beat.start}–{beat.end}s
              </span>
              <p>{beat.action.zh}</p>
            </div>
          ))}
        </div>
        <div className="studio-camera-note">
          <strong>运镜</strong>
          <p>{s.camera.zh}</p>
        </div>
        {s.narration && (
          <div className="studio-voice-card">
            <strong>旁白 / 独立后期</strong>
            <span>
              预计 {(s.narration.replace(/\s/g, "").length / 4).toFixed(1)} 秒
            </span>
            <p>{s.narration}</p>
          </div>
        )}
        {s.notes && (
          <div className="studio-camera-note">
            <strong>连续性与导演备注</strong>
            <p>{s.notes}</p>
          </div>
        )}
        {s.imageHistory?.length || s.videoHistory?.length ? (
          <details className="studio-shot-history">
            <summary>历史版本（原始文件保留）</summary>
            <div>
              {s.imageHistory?.map((asset, i) => (
                <a
                  key={asset}
                  href={`/api/assets/${asset}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/assets/${asset}`}
                    alt={`分镜图版本 ${i + 1}`}
                  />
                  <span>分镜图 {i + 1}</span>
                </a>
              ))}
              {s.videoHistory?.map((asset, i) => (
                <a
                  key={asset}
                  href={`/api/assets/${asset}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Film size={20} />
                  <span>视频 {i + 1}</span>
                </a>
              ))}
            </div>
          </details>
        ) : null}
        {editing && (
          <ShotEditor
            shot={s}
            references={p.references}
            busy={busy}
            onSave={async (shot) => {
              await onPatch({ shot });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </section>
      <aside className="studio-shot-console">
        <span className="studio-eyebrow">GENERATION CONSOLE</span>
        <div className="studio-console-title">
          <h3>画面提示词</h3>
          <div>
            <button data-active={lang === "zh"} onClick={() => setLang("zh")}>
              中
            </button>
            <button data-active={lang === "en"} onClick={() => setLang("en")}>
              EN
            </button>
          </div>
        </div>
        <div className="studio-prompt-preview">
          <pre>{prompt}</pre>
        </div>
        <button
          className="studio-button-quiet studio-full-width"
          onClick={() => void copy(shotPrompt(p, s, "en"))}
        >
          <Copy size={13} />
          复制英文生成提示词
        </button>
        <div className="studio-console-refs">
          <span className="studio-eyebrow">绑定参考</span>
          {s.refs.map((id) => {
            const ref = p.references.find((r) => r.id === id);
            return (
              <div key={id}>
                {ref?.assetName ? (
                  <img src={`/api/assets/${ref.assetName}`} alt={ref.name} />
                ) : (
                  <ImagePlus size={15} />
                )}
                <span>
                  <strong>{ref?.name}</strong>
                  <small>@{id}</small>
                </span>
                {ref?.assetName ? <Check size={12} /> : <span>待生成</span>}
              </div>
            );
          })}
        </div>
        <label className="studio-feedback-label">
          修改意见
          <textarea
            aria-label="镜头修改意见"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="记录需要调整的动作、角色或构图…"
          />
        </label>
        <button
          className="studio-button-quiet"
          disabled={busy || !(media === "image" ? s.imageAsset : s.videoAsset)}
          onClick={() =>
            void onAction("review", {
              targetId: s.id,
              kind: media,
              approved: false,
              feedback,
            })
          }
        >
          保存意见 / 标记待修改
        </button>
        <div className="studio-console-actions">
          {s.error?.includes("确认") && !s.taskId && (
            <button
              className="studio-button-quiet"
              disabled={busy}
              onClick={() =>
                void onAction(s.imageAsset ? "video" : "storyboard", {
                  targetId: s.id,
                  force: true,
                })
              }
            >
              确认重新{s.imageAsset ? "提交视频" : "生成分镜图"}
            </button>
          )}
          <button
            className="studio-button"
            disabled={busy || !!s.imageApproved}
            onClick={() =>
              void onAction("storyboard", {
                targetId: s.id,
                force: !!s.imageAsset,
              })
            }
          >
            {pending === `storyboard:${s.id}` ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : (
              <ImagePlus size={14} />
            )}{" "}
            {s.imageAsset ? "重新生成分镜图" : "生成分镜图"}
          </button>
          <button
            className="studio-button studio-button-secondary"
            disabled={busy || !s.imageAsset || !!s.taskId || !!s.videoApproved}
            onClick={() => {
              setMedia("video");
              void onAction("video", { targetId: s.id, force: !!s.videoAsset });
            }}
          >
            <Film size={14} />
            {s.taskId
              ? "视频生成中…"
              : s.videoAsset
                ? "重新生成视频"
                : "生成视频"}{" "}
            <span>{s.duration}s</span>
          </button>
        </div>
        <p className="studio-console-footnote">
          统一风格前缀 · 时间动作节拍 · 负面词末行
          <br />
          视频使用分镜首帧，默认无声。
        </p>
      </aside>
    </>
  );
}
function ClapFrame() {
  return <Film size={32} strokeWidth={1} />;
}
function EmptyState({
  title,
  text,
  onClick,
  label,
}: {
  title: string;
  text: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <div className="studio-empty-state">
      <Film size={35} strokeWidth={1} />
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="studio-button-quiet" onClick={onClick}>
        {label}
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("已复制");
  } catch {
    toast.error("剪贴板不可用，请手动选择文本复制");
  }
}
