import { ZodError } from "zod";
import { errorResponse } from "../api-error";
import { StudioError } from "./store";
export function studioError(error: unknown) {
  if (error instanceof StudioError)
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
      { error: { message: "请求 JSON 格式错误" } },
      { status: 400 },
    );
  return errorResponse(error);
}
