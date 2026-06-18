import type { ZodType } from "zod";
import { ApiError } from "./http";

/** Validate unknown input against a schema, throwing ApiError(400) on failure. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    throw new ApiError(400, message);
  }
  return result.data;
}
