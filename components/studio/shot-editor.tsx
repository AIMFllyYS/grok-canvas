"use client";
import { useState } from "react";
import { Plus, Save, X } from "lucide-react";
import type { Reference, Shot } from "@/lib/studio/schema";
export function ShotEditor({
  shot,
  references,
  busy,
  onSave,
  onCancel,
}: {
  shot: Shot;
  references: Reference[];
  busy: boolean;
  onSave: (shot: Shot) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Shot>(structuredClone(shot));
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [error, setError] = useState("");
  const updateBeat = (index: number, patch: Partial<Shot["beats"][number]>) =>
    setDraft((d) => ({
      ...d,
      beats: d.beats.map((b, i) => (i === index ? { ...b, ...patch } : b)),
    }));
  const addBeat = () =>
    setDraft((d) => {
      const beats = structuredClone(d.beats),
        last = beats.at(-1)!;
      if (beats.length >= 4 || last.end - last.start < 2) return d;
      const midpoint = Math.round(((last.start + last.end) / 2) * 10) / 10;
      const end = last.end;
      last.end = midpoint;
      beats.push({
        start: midpoint,
        end,
        action: {
          zh: "描述这个节拍的可见动作与结束姿态",
          en: "Describe the visible action and ending pose",
        },
      });
      return { ...d, beats };
    });
  const removeBeat = (index: number) =>
    setDraft((d) => {
      if (d.beats.length <= 2) return d;
      const beats = structuredClone(d.beats),
        removed = beats.splice(index, 1)[0]!;
      if (index) beats[index - 1]!.end = removed.end;
      else beats[0]!.start = 0;
      return { ...d, beats };
    });
  return (
    <form
      className="studio-shot-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          await onSave(draft);
        } catch (err) {
          setError(err instanceof Error ? err.message : "镜头保存失败");
        }
      }}
    >
      <div className="studio-section-line">
        <h3>镜头与动作设计</h3>
        <div>
          <button
            type="button"
            data-active={language === "zh"}
            onClick={() => setLanguage("zh")}
          >
            中文
          </button>
          <button
            type="button"
            data-active={language === "en"}
            onClick={() => setLanguage("en")}
          >
            English
          </button>
        </div>
      </div>
      <div className="studio-form-row">
        <label>
          镜头标题
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          生成片段时长
          <select
            value={draft.duration}
            onChange={(e) => {
              const duration = Number(e.target.value) as Shot["duration"];
              const scale = duration / draft.duration;
              setDraft({
                ...draft,
                duration,
                beats: draft.beats.map((b) => ({
                  ...b,
                  start: Math.round(b.start * scale * 10) / 10,
                  end: Math.round(b.end * scale * 10) / 10,
                })),
              });
            }}
          >
            {[6, 10, 15].map((n) => (
              <option key={n} value={n}>
                {n} 秒
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        场景
        <input
          value={draft.scene}
          onChange={(e) => setDraft({ ...draft, scene: e.target.value })}
        />
      </label>
      <label>
        初始构图与连续性 · {language === "zh" ? "中文" : "English"}
        <textarea
          value={draft.description[language]}
          onChange={(e) =>
            setDraft({
              ...draft,
              description: { ...draft.description, [language]: e.target.value },
            })
          }
        />
      </label>
      <label>
        运镜 · {language === "zh" ? "中文" : "English"}
        <textarea
          value={draft.camera[language]}
          onChange={(e) =>
            setDraft({
              ...draft,
              camera: { ...draft.camera, [language]: e.target.value },
            })
          }
        />
      </label>
      <div className="studio-section-line">
        <strong>时间动作节拍</strong>
        <button
          type="button"
          className="studio-button-quiet"
          disabled={draft.beats.length >= 4}
          onClick={addBeat}
        >
          <Plus size={13} />
          增加节拍
        </button>
      </div>
      {draft.beats.map((beat, i) => (
        <div className="studio-beat-editor" key={i}>
          <div>
            <label>
              开始（秒）
              <input
                type="number"
                step="0.1"
                min="0"
                value={beat.start}
                onChange={(e) =>
                  updateBeat(i, { start: Number(e.target.value) })
                }
              />
            </label>
            <span>→</span>
            <label>
              结束（秒）
              <input
                type="number"
                step="0.1"
                min="1"
                max={draft.duration}
                value={beat.end}
                onChange={(e) => updateBeat(i, { end: Number(e.target.value) })}
              />
            </label>
            <button
              type="button"
              className="studio-icon-button"
              aria-label={`移除第${i + 1}个动作节拍`}
              disabled={draft.beats.length <= 2}
              onClick={() => removeBeat(i)}
            >
              <X size={13} />
            </button>
          </div>
          <label>
            第 {i + 1} 个动作 · {language === "zh" ? "中文" : "English"}
            <textarea
              value={beat.action[language]}
              onChange={(e) =>
                updateBeat(i, {
                  action: { ...beat.action, [language]: e.target.value },
                })
              }
            />
          </label>
        </div>
      ))}
      <fieldset>
        <legend>绑定固定参考（最多 5 份）</legend>
        <div className="studio-editor-reference-options">
          {references.map((ref) => (
            <label key={ref.id}>
              <input
                type="checkbox"
                checked={draft.refs.includes(ref.id)}
                disabled={
                  !draft.refs.includes(ref.id) && draft.refs.length >= 5
                }
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    refs: e.target.checked
                      ? [...draft.refs, ref.id]
                      : draft.refs.filter((id) => id !== ref.id),
                  })
                }
              />
              <span>
                {ref.name}
                <small>@{ref.id}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        独立旁白 / 对白
        <textarea
          value={draft.narration}
          onChange={(e) => setDraft({ ...draft, narration: e.target.value })}
        />
      </label>
      <label>
        导演备注
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </label>
      <p>
        每拍至少 1 秒，从 0
        秒连续覆盖完整片段。英文内容会直接用于生成，请保持中英文动作一致。保存画面变更会重置当前产物，历史版本保留。
      </p>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      <div className="studio-editor-actions">
        <button className="studio-button" type="submit" disabled={busy}>
          <Save size={14} />
          保存镜头
        </button>
        <button
          type="button"
          className="studio-button-quiet"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </form>
  );
}
