import { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  statusCode: number;
  /** Optional machine-readable reason ("care_recipient") and details the screen can act on. */
  code?: string;
  data?: Record<string, unknown>;

  constructor(message: string, statusCode = 500, extra?: { code?: string; data?: Record<string, unknown> }) {
    super(message);
    this.statusCode = statusCode;
    this.code = extra?.code;
    this.data = extra?.data;
  }
}

export const errorHandler = (
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  let statusCode = err instanceof AppError ? err.statusCode : 500;
  let message =
    err instanceof AppError ? err.message : "Internal Server Error";

  if (
    !(err instanceof AppError) &&
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "LIMIT_FILE_SIZE"
  ) {
    statusCode = 400;
    message = "This file is too large. The maximum is 15 MB.";
  }

  if (
    !(err instanceof AppError) &&
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  ) {
    statusCode = 409;
    const rawMessage =
      "message" in err && typeof err.message === "string" ? err.message : "";
    if (rawMessage.includes("phoneKey") || rawMessage.includes("phone.number")) {
      message = "This mobile number is already registered";
    } else if (rawMessage.includes("email")) {
      message = "This email is already registered";
    } else if (rawMessage.includes("familyInvitation")) {
      message = "This member was already added. Refresh the family page.";
    } else {
      message = "A record with these details already exists";
    }
  }

  console.error("API Error:", err.message, err.stack);

  res.status(statusCode).json({
    success: false,
    message,
    ...(err instanceof AppError && err.code ? { code: err.code, data: err.data } : {}),
    error:
      process.env.NODE_ENV === "development"
        ? { message: err.message, stack: err.stack }
        : undefined,
  });
};

export default errorHandler;
