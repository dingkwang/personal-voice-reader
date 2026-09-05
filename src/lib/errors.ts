export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  if (error instanceof Error && error.name === "ZodError") {
    return Response.json(
      { error: "请求参数格式不正确", code: "VALIDATION_ERROR" },
      { status: 422 },
    );
  }

  console.error(error);
  return Response.json(
    { error: "服务器暂时无法完成请求", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}
