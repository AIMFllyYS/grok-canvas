import type { UIMessage } from "ai";

/** Older AI SDK streams can omit assistant IDs. Repair them deterministically on read. */
export function normalizeMessages<T extends UIMessage>(
  messages: T[],
  namespace: string,
): T[] {
  const seen = new Set<string>();
  return messages.map((message, index) => {
    let id = message.id;
    if (!id || seen.has(id)) {
      id = `${namespace}-message-${index}`;
      while (seen.has(id)) id += "-";
    }
    seen.add(id);
    return id === message.id ? message : { ...message, id };
  });
}

/** A stopped stream must not leave a perpetual running tool in saved history. */
export function finalizeInterruptedMessages<T extends UIMessage>(messages:T[],namespace:string):T[]{
  return normalizeMessages(messages,namespace).map(message=>({
    ...message,parts:message.parts.map(part=>{
      if((part.type==="text"||part.type==="reasoning")&&part.state==="streaming")return {...part,state:"done"};
      if(part.type.startsWith("tool-")&&"state" in part&&(part.state==="input-streaming"||part.state==="input-available"||(part.state==="output-available"&&part.preliminary))){
        if(part.state==="input-streaming")return {type:"text",text:"工具参数尚未完整接收，执行已中断。请检查项目状态后继续。"};
        const {output:_output,approval:_approval,...rest}=part;
        return {...rest,state:"output-error",input:part.input,preliminary:undefined,errorText:"上次执行已中断。请先查询制作状态再继续，已提交的生成不会自动重发。"};
      }
      return part;
    })
  } as T));
}
