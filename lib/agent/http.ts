import { ZodError } from "zod";
import { AgentError } from "./store";
import { errorResponse } from "../api-error";
export function agentError(error: unknown) {
  if (error instanceof AgentError)
    return Response.json(
      { error: { message: error.message } },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
        },
      },
      { status: 400 },
    );
  if (error instanceof SyntaxError)
    return Response.json(
      { error: { message: "请求格式错误" } },
      { status: 400 },
    );
  return errorResponse(error);
}
