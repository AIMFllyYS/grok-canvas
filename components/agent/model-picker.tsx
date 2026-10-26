"use client";
import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Zap,
} from "lucide-react";
import { ChoiceSelect } from "./choice-select";
import type { AgentSettings } from "@/lib/agent/schema";
type Model = {
  id: string;
  name: string;
  fastId?: string;
  contextWindows: number[];
  efforts: string[];
};
export function ModelPicker({
  settings,
  onChange,
  disabled,
}: {
  settings: AgentSettings;
  onChange: (s: AgentSettings) => Promise<void>;
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<{
      models: Model[];
      defaultSettings: AgentSettings;
      source: string;
    }>(),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [models, setModels] = useState(false),
    [draft, setDraft] = useState<number>();
  useEffect(() => {
    let active = true;
    fetch("/api/agent/models")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error?.message ?? "无法读取模型");
        if (active) setCatalog(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const selected = { ...catalog?.defaultSettings, ...settings },
    model = catalog?.models.find((m) => m.id === selected.model),
    locked = disabled || saving;
  const levels = [...(model?.efforts ?? [])].sort(
    (a, b) =>
      ["low", "medium", "high", "xhigh"].indexOf(a) -
      ["low", "medium", "high", "xhigh"].indexOf(b),
  );
  const index = Math.max(0, levels.indexOf(selected.effort ?? "")),
    current = draft ?? index,
    names: Record<string, string> = {
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
    };
  const save = async (next: AgentSettings) => {
    setSaving(true);
    setError("");
    try {
      await onChange(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      setDraft(undefined);
    }
  };
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) {
          setModels(false);
          setDraft(undefined);
        }
      }}
    >
      <Popover.Trigger
        className="agent-model-trigger"
        aria-label="选择 Agent 模型"
        disabled={disabled}
      >
        <span>{model?.name ?? "模型"}</span>
        {selected.fast && <Zap size={11} />}
        <ChevronDown size={11} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          className="agent-menu-layer"
        >
          <Popover.Popup
            className={`agent-model-menu ${models ? "agent-model-list" : "agent-effort-menu"}`}
          >
            {models ? (
              <>
                <header>
                  <button
                    className="agent-icon-button"
                    aria-label="返回推理设置"
                    onClick={() => setModels(false)}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <Popover.Title>模型</Popover.Title>
                  <span>Grok CLI</span>
                </header>
                <div className="agent-model-options">
                  {catalog?.models.map((m) => (
                    <button
                      key={m.id}
                      disabled={locked}
                      aria-pressed={m.id === model?.id}
                      className="agent-model-option"
                      onClick={() => {
                        setModels(false);
                        void save({
                          model: m.id,
                          fast: false,
                          contextWindow: m.contextWindows.includes(
                            selected.contextWindow ?? 0,
                          )
                            ? selected.contextWindow
                            : m.contextWindows[0],
                          effort: m.efforts.includes(selected.effort ?? "")
                            ? selected.effort
                            : m.efforts.includes("high")
                              ? "high"
                              : m.efforts[0],
                        });
                      }}
                    >
                      <span>
                        <strong>{m.name}</strong>
                        <small>{m.contextWindows.at(-1)! / 1000}K 上下文</small>
                      </span>
                      {m.id === model?.id && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="agent-effort-heading">
                  <button
                    className="agent-icon-button agent-fast-button"
                    aria-label="Fast 模式"
                    aria-pressed={!!selected.fast}
                    title={model?.fastId ? "Fast 模式" : "此模型未提供 Fast"}
                    disabled={locked || !model?.fastId}
                    onClick={() =>
                      void save({ ...selected, fast: !selected.fast })
                    }
                  >
                    <Zap size={15} />
                  </button>
                  <div>
                    <Popover.Title>
                      {names[levels[current] ?? ""] ?? "推理设置"}
                    </Popover.Title>
                    <button
                      className="agent-model-link"
                      aria-label="切换模型"
                      disabled={locked || !catalog}
                      onClick={() => setModels(true)}
                    >
                      {model?.name ?? "正在读取模型"}
                      <ChevronRight size={11} />
                    </button>
                  </div>
                  <button
                    className="agent-icon-button"
                    aria-label="重置推理设置"
                    title="恢复 CLI 默认设置"
                    disabled={locked || !model}
                    onClick={() =>
                      void save({
                        ...selected,
                        effort: levels.includes(
                          catalog?.defaultSettings.effort ?? "",
                        )
                          ? catalog?.defaultSettings.effort
                          : levels.at(-1),
                        fast:
                          catalog?.defaultSettings.model === model?.id &&
                          catalog?.defaultSettings.fast,
                      })
                    }
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
                {levels.length > 1 && (
                  <Slider.Root
                    value={current}
                    min={0}
                    max={levels.length - 1}
                    step={1}
                    disabled={locked}
                    onValueChange={(v) => setDraft(Array.isArray(v) ? v[0] : v)}
                    onValueCommitted={(v) => {
                      const i = Array.isArray(v) ? v[0] : v;
                      void save({ ...selected, effort: levels[i] });
                    }}
                    className="agent-effort-slider"
                  >
                    <Slider.Control className="agent-slider-control">
                      <Slider.Track className="agent-slider-track">
                        <Slider.Indicator className="agent-slider-fill" />
                        {levels.map((level, i) => (
                          <span
                            key={level}
                            className="agent-slider-dot"
                            style={{
                              left: `${10 + (i / (levels.length - 1)) * 80}%`,
                            }}
                          />
                        ))}
                      </Slider.Track>
                      <Slider.Thumb
                        className="agent-slider-thumb"
                        aria-label="推理强度"
                        getAriaValueText={(_formatted, v) =>
                          names[levels[v] ?? ""] ?? ""
                        }
                      />
                    </Slider.Control>
                  </Slider.Root>
                )}
                <div className="agent-effort-context">
                  <span>
                    {saving
                      ? "保存中…"
                      : selected.fast
                        ? "Fast · 已开启"
                        : "标准速度"}
                  </span>
                  <ChoiceSelect
                    label="上下文窗口"
                    value={String(selected.contextWindow ?? "")}
                    disabled={locked || !model}
                    options={
                      model?.contextWindows.map((v) => ({
                        value: String(v),
                        label: `${v / 1000}K 上下文`,
                      })) ?? []
                    }
                    onChange={(v) =>
                      void save({ ...selected, contextWindow: Number(v) })
                    }
                  />
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="agent-menu-error">
                {error}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
