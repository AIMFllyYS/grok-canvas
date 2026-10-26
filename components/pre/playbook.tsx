"use client";
import { useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { NodeGallery } from "./node-gallery";
import "@xyflow/react/dist/style.css";
import { useTheme } from "next-themes";
import { ArrowLeft, Check, FileText, RefreshCw } from "lucide-react";
import { WorkButton, ApprovalCard, FileChip } from "./primitives";
import { AgentComposer } from "./agent-composer";
import { ParameterView } from "./parameter-view";
import { NodeAddMenu } from "./node-add-menu";
import { AgentGlyph, ReasoningGlyph, StudioMark } from "@/components/studio/studio-icons";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import { TextNode } from "@/components/canvas/text-node";
import { WorkflowNode } from "@/components/canvas/workflow-node";
import { FloatingAgent } from "./floating-agent";
import type { ToolUIPart } from "ai";
const nodeTypes = { text: TextNode, prompt: TextNode, workflow: WorkflowNode };
const fixtures: Node[] = [
  { id: "text", type: "text", position: { x: 0, y: 0 }, data: { name: "品牌短片完整创意与镜头说明_最终确认版.md", text: "### 创作主题\n让日常的小事被看见。\n\n- 保留纸张纹理\n- 一个连贯动作\n- 克制的镜头语言" } },
  { id: "prompt", type: "prompt", position: { x: 350, y: 0 }, data: { name: "全片视觉规范", text: "Cinematic hand-drawn animation. Soft natural light. Maintain character consistency." } },
  { id: "workflow", type: "workflow", position: { x: 0, y: 300 }, data: { name: "导演脚本", stage: "script", count: 3, text: "**已规划 3 个片段**\n\n主题 → 脚本批准 → 参考图库 → 分镜制作。" } },
];
export function Playbook() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState("agent"), [input, setInput] = useState(""), [approved, setApproved] = useState(false), [open, setOpen] = useState(false);
  return <div className="studio-app pre-playbook" data-appearance={theme ?? "paper"}>
    <header className="studio-topbar"><a href="/" aria-label="返回工作台"><ArrowLeft size={16}/></a><StudioMark size={26}/><strong>组件规范</strong><nav aria-label="组件分类">{[["agent","Agent"],["nodes","画布节点"],["controls","菜单与操作"]].map(([id,label])=><WorkButton key={id} variant={tab === id ? "primary" : "ghost"} onClick={()=>setTab(id!)}>{label}</WorkButton>)}</nav><select aria-label="预览外观" value={theme ?? "paper"} onChange={e=>setTheme(e.target.value)}><option value="paper">纸面</option><option value="light">黑白</option><option value="dark">墨黑</option></select></header>
    <main className="pre-playbook-main"><div className="pre-playbook-intro"><h1>让内容占据主角。</h1><p>生产组件直接预览 · 同一圆角、字号与操作层级。此页交互仅用于预览。</p></div>
      {tab === "agent" ? <div className="pre-playbook-grid"><section className="pre-spec-card"><div className="pre-spec-heading"><AgentGlyph size={17}/><h2>对话与输入</h2><span>12px / 1.75</span></div><MessageResponse mode="static">{"### 导演脚本已准备好\n我们把这段故事组织成 **3 个连续片段**。请审阅脚本，确认后生成角色与场景参考图。\n\n| 步骤 | 状态 |\n| --- | --- |\n| 创作主题 | 已整理 |\n| 完整脚本 | 待批准 |"}</MessageResponse><AgentComposer value={input} onChange={setInput} onSend={()=>setInput("")} busy={false} disabled={false} onStop={()=>{}} onUpload={()=>setInput("上传入口示例；实际素材上传请回到工作台。") } sources={[{id:"file",name:"品牌短片_创意简报_最终确认版本.md",kind:"text",text:""}]}><span className="pre-model-tier">Grok · STANDARD</span></AgentComposer></section>
      <section className="pre-spec-card"><div className="pre-spec-heading"><ReasoningGlyph size={17}/><h2>执行过程</h2><span>默认折叠</span></div><Reasoning text="**制作计划**：先读取项目，检查参考素材是否齐全，再生成分镜。这里仅展示模型返回的推理摘要。" streaming={false}/><Tool part={{type:"tool-write_director_script",toolCallId:"demo-done",state:"output-available",input:{brief:"制作一段 **纸面风格** 的品牌短片。\n\n- 时长：30秒\n- 不含对白"},output:{shotCount:3,message:"脚本已保存，等待确认批准。"}} as ToolUIPart}/><Tool part={{type:"tool-generate_reference",toolCallId:"demo-error",state:"output-error",input:{referenceId:"CHARACTER_01",prompt:"**角色定装**\n\n保留同一服装、造型与配色。"},errorText:"上游暂时不可用。参数已保留，请检查状态后重试。"} as ToolUIPart}/><ApprovalCard approved={approved} onApprove={()=>setApproved(true)} onReject={()=>setApproved(false)}>批准只对应当前脚本版本。修改后需要重新确认。</ApprovalCard></section></div> : tab === "nodes" ? <NodeGallery fixtures={fixtures}/> : <div className="pre-playbook-grid"><section className="pre-spec-card"><div className="pre-spec-heading"><h2>操作层级</h2><span>常用可见，次要折叠</span></div><div className="pre-spec-row"><WorkButton variant="primary"><Check size={13}/>确认批准</WorkButton><WorkButton>保存修改</WorkButton><WorkButton variant="ghost" aria-label="示例刷新"><RefreshCw size={14}/></WorkButton><NodeAddMenu onAdd={type=>setInput(`已选择 ${type} 节点（预览）`)}/></div><p>{input || "添加菜单收纳图片、视频、文本与提示词参数。"}</p><div className="pre-spec-row"><FileChip name="非常长的原始脚本文件名称_最终确认与导演备注_2026.md" kind="text"/></div><ParameterView value={{theme:"纸面与墨黑",radius:"控件 8px / 节点 12px / 浮窗 16px",spacing:"4 / 8 / 12 / 16 / 24"}}/></section><section className="pre-spec-card"><div className="pre-spec-heading"><h2>可移动 Agent</h2></div><p>拖动、键盘方向键移动，右下角调整大小。窗口变化时自动收回可视范围。</p><WorkButton onClick={()=>setOpen(true)}>预览浮动面板</WorkButton></section></div>}
      <details className="pre-reference-notes"><summary>交互参考与设计取舍</summary><p><a href="https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5" target="_blank" rel="noreferrer">Lindy · 执行步骤</a> · <a href="https://mobbin.com/screens/536f1280-e59b-43c4-8dd0-3f0e91e15695" target="_blank" rel="noreferrer">Dropbox Dash · 附件输入</a> · <a href="https://mobbin.com/screens/6fba30a0-6d21-4f55-945f-177a2daf03c5" target="_blank" rel="noreferrer">MagicPath · 就地操作菜单</a> · <a href="https://mobbin.com/flows/1b716e45-ac0b-4cab-b7c0-32788a1fd703" target="_blank" rel="noreferrer">Mistral · 修改审阅</a></p><p>操作贴近对象；刷新紧邻状态；次要配置折叠；避免为新操作增加无必要的整行。</p></details>
    </main>{tab === "controls" && <FloatingAgent open={open} onOpenChange={setOpen}><div className="pre-spec-card"><h2>共享浮窗组件</h2><p>这是生产工作台使用的同一个可拖动、可缩放容器。</p><AgentComposer value={input} onChange={setInput} onSend={()=>setInput("")} busy={false} disabled={false} onStop={()=>{}} onUpload={()=>{}}/></div></FloatingAgent>}
  </div>;
}
