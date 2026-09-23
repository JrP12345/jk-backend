import mongoose from "mongoose";
import {
  DEFAULT_PAGINATION_LIMIT,
  MAX_PAGINATION_LIMIT,
} from "./scalability.ts";

export interface CursorPaginationParams {
  cursor?: string;
  limit: number;
}

export interface DecodedCursor {
  id: string;
  timestamp?: number;
  [key: string]: any;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
  limit: number;
}

/**
 * Parses and bounds pagination parameters with deterministic maximum limits.
 */
export function getCursorPaginationParams(
  query: { cursor?: string; limit?: string | number },
  defaultLimit = DEFAULT_PAGINATION_LIMIT,
  maxLimit = MAX_PAGINATION_LIMIT,
): CursorPaginationParams {
  const parsedLimit = Number(query?.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), maxLimit)
    : defaultLimit;

  return {
    cursor: typeof query?.cursor === "string" && query.cursor.trim() !== "" ? query.cursor.trim() : undefined,
    limit,
  };
}

/**
 * Base64url encodes cursor data deterministically.
 */
export function encodeCursor(data: { id: string | mongoose.Types.ObjectId; timestamp?: Date | number; [key: string]: any }): string {
  const payload = {
    id: data.id.toString(),
    t: data.timestamp instanceof Date ? data.timestamp.getTime() : data.timestamp,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decodes a cursor string back into its constituent parts.
 */
export function decodeCursor(cursor?: string): DecodedCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== "string") return null;
    return {
      id: parsed.id,
      timestamp: typeof parsed.t === "number" ? parsed.t : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Constructs an optimized Mongoose filter using deterministic compound sorting keys.
 * Sort defaults to descending (most recent first): { [timeField]: -1, _id: -1 }.
 */
export function buildCursorFilter(
  decoded: DecodedCursor | null,
  options: {
    timeField?: string;
    sortDirection?: "desc" | "asc";
  } = {},
): Record<string, any> {
  if (!decoded) return {};

  const timeField = options.timeField || "createdAt";
  const isDesc = options.sortDirection !== "asc";
  const op = isDesc ? "$lt" : "$gt";

  const targetId = mongoose.Types.ObjectId.isValid(decoded.id)
    ? new mongoose.Types.ObjectId(decoded.id)
    : decoded.id;

  if (decoded.timestamp !== undefined) {
    const targetDate = new Date(decoded.timestamp);
    return {
      $or: [
        { [timeField]: { [op]: targetDate } },
        { [timeField]: targetDate, _id: { [op]: targetId } },
      ],
    };
  }

  return {
    _id: { [op]: targetId },
  };
}

/**
 * Formats a paginated items array (queried with limit + 1) into a clean cursor-paginated result.
 */
export function formatCursorResult<T extends { _id: any; createdAt?: any }>(
  items: T[],
  limit: number,
  timeField: string = "createdAt",
): CursorPaginatedResult<T> {
  const hasNextPage = items.length > limit;
  const resultItems = hasNextPage ? items.slice(0, limit) : items;

  let nextCursor: string | null = null;
  if (hasNextPage && resultItems.length > 0) {
    const lastItem = resultItems[resultItems.length - 1];
    const ts = lastItem[timeField as keyof T]
      ? new Date(lastItem[timeField as keyof T] as any).getTime()
      : undefined;
    nextCursor = encodeCursor({
      id: lastItem._id,
      timestamp: ts,
    });
  }

  return {
    items: resultItems,
    nextCursor,
    hasNextPage,
    limit,
  };
}
