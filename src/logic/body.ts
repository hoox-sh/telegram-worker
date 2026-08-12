/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Errors } from "@hoox-sh/hoox-shared/errors";

/**
 * Hard cap for JSON request bodies on telegram-worker routes.
 * Alerts and Telegram update envelopes are small; photos arrive as file_ids.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024; // 64 KiB

export type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

/**
 * Early reject via Content-Length when present.
 */
export function checkJsonBodySize(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Response | null {
  const contentLength = request.headers.get("Content-Length");
  if (!contentLength) return null;
  const size = parseInt(contentLength, 10);
  if (!Number.isFinite(size) || size < 0) {
    return Errors.badRequest("Invalid Content-Length");
  }
  if (size > maxBytes) {
    return Errors.badRequest(
      `Request body too large (max ${maxBytes} bytes)`
    );
  }
  return null;
}

/**
 * Parse JSON with a hard byte cap (does not trust Content-Length alone).
 * Oversized / empty / malformed bodies yield 400.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<ReadJsonResult> {
  const sizeError = checkJsonBodySize(request, maxBytes);
  if (sizeError) return { ok: false, response: sizeError };

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: Errors.badRequest("Empty request body") };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore cancel errors */
        }
        return {
          ok: false,
          response: Errors.badRequest(
            `Request body too large (max ${maxBytes} bytes)`
          ),
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      response: Errors.badRequest("Failed to read request body"),
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (total === 0) {
    return { ok: false, response: Errors.badRequest("Empty request body") };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } catch {
    return {
      ok: false,
      response: Errors.badRequest("Failed to decode request body"),
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: Errors.badRequest("Invalid JSON") };
  }
}
