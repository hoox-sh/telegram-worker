/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type EnvWithKV,
  logKvTimestamp,
} from "@jango-blockchained/hoox-shared/kvUtils"; // Import shared function
// KVNamespace, Ai, VectorizeIndex, R2Bucket types are globally available from worker-configuration.d.ts
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import {
  createLogger,
  requireInternalAuth,
  withRequestLog,
} from "@jango-blockchained/hoox-shared/middleware";
import { TELEGRAM_ALERT_AUTH_KEY_FIELDS } from "@jango-blockchained/hoox-shared/service-bindings";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";

import { handleWebhookRequest } from "./handlers/webhook";
import { sendTelegramNotification } from "./logic/telegram";
import {
  generateEmbeddings,
  insertEmbeddings,
  queryEmbeddings,
} from "./logic/rag";
import { handleGetLatestTradeSignalR2 } from "./logic/telegram";

// --- Type Definitions ---

export interface Env extends Cloudflare.Env, AnalyticsEnv, EnvWithKV {
  CONFIG_KV: KVNamespace;
  UPLOADS_BUCKET: R2Bucket;
  VECTORIZE_INDEX: VectorizeIndex;
  AI: Ai;
  ANALYTICS_SERVICE: Fetcher;
}

// Payload structure for incoming requests (both /process and /webhook)
interface NotificationPayload {
  message: string;
  chatId?: string; // Optional: if not provided, use default from TG_CHAT_ID_BINDING
}

// --- Constants ---
const ALERT_ENDPOINT = "/alert"; // Internal notification endpoint (replaces legacy /process)
const PROCESS_ENDPOINT = "/process"; // Legacy — redirects to /alert
const WEBHOOK_ENDPOINT = "/webhook"; // Telegram Bot API webhook endpoint

// --- Worker Definition ---

const logger = createLogger({ service: "telegram-worker", module: "router" });

const router = createRouter<Env>();

// Define routes
router.get(
  "/health",
  async (_request: Request, _env: Env, _ctx: ExecutionContext) => {
    return healthCheck({ worker: "telegram-worker" });
  }
);

// POST /alert — internal notification endpoint (requires internal auth)
// Called by: hoox, trade-worker, agent-worker, report-worker, web3-wallet-worker
router.post(
  ALERT_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      logKvTimestamp(env, "CONFIG_KV").catch((err) =>
        logger.error("logKvTimestamp failed", { error: String(err) })
      )
    );
    return await handleAlertRequest(request, env, ctx);
  }
);

// POST /process — legacy endpoint, redirects to /alert
router.post(
  PROCESS_ENDPOINT,
  async (_request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      logKvTimestamp(env, "CONFIG_KV").catch((err) =>
        logger.error("logKvTimestamp failed", { error: String(err) })
      )
    );
    return Response.redirect(
      new URL(ALERT_ENDPOINT, _request.url).toString(),
      308
    );
  }
);

// POST /webhook — Telegram Bot API webhook endpoint
// Receives updates from Telegram for interactive bot commands
router.post(
  WEBHOOK_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      logKvTimestamp(env, "CONFIG_KV").catch((err) =>
        logger.error("logKvTimestamp failed", { error: String(err) })
      )
    );
    return await handleWebhookRequest(request, env, ctx, logger);
  }
);

export default {
  fetch: withRequestLog<Env>(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "telegram-worker", module: "router" }
  ),
};

/**
 * Handles the internal notification request (/alert endpoint).
 * Called by other workers via service binding to send Telegram messages.
 *
 * Accepts both body shapes (H4 contract fix):
 *  1. Nested ProcessRequestBody: { requestId?, payload: { message, chatId? } }
 *  2. Flat: { requestId?, message, chatId? }
 *
 * Auth is checked BEFORE body parsing (fail-fast).
 */
async function handleAlertRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let incomingRequestId = "unknown";

  try {
    // Auth first — never parse untrusted body before authorization
    const authResult = requireInternalAuth(
      request,
      env,
      TELEGRAM_ALERT_AUTH_KEY_FIELDS
    );
    if (authResult) return authResult;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Errors.badRequest("Invalid JSON");
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return Errors.badRequest("Request body must be a JSON object");
    }

    const body = raw as Record<string, unknown>;
    incomingRequestId =
      typeof body.requestId === "string" ? body.requestId : "unknown";

    // Normalize nested vs flat payload shapes
    let notification: NotificationPayload | null = null;
    if (
      body.payload &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
    ) {
      const p = body.payload as Record<string, unknown>;
      if (typeof p.message === "string") {
        notification = {
          message: p.message,
          chatId: typeof p.chatId === "string" ? p.chatId : undefined,
        };
      }
    } else if (typeof body.message === "string") {
      notification = {
        message: body.message,
        chatId:
          typeof body.chatId === "string"
            ? body.chatId
            : typeof body.chatId === "number"
              ? String(body.chatId)
              : undefined,
      };
    }

    if (!notification) {
      return Errors.badRequest(
        "Missing message — send { message } or { payload: { message } }"
      );
    }

    const result = await sendTelegramNotification(
      notification,
      env,
      ctx,
      logger,
      incomingRequestId
    );

    return createJsonResponse({ success: true, result }, 200);
  } catch (error: unknown) {
    const errorMsg = toError(error, "Internal Server Error");
    logger.error(`[${incomingRequestId}] Error in handleAlertRequest:`, {
      error: errorMsg,
    });
    return Errors.internal(errorMsg);
  }
}

// Export helper functions for testing
export {
  generateEmbeddings,
  insertEmbeddings,
  queryEmbeddings,
  handleGetLatestTradeSignalR2,
};
