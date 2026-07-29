/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  trackAnalytics,
  type AnalyticsEnv,
} from "@jango-blockchained/hoox-shared/analytics";
import type { Logger } from "@jango-blockchained/hoox-shared/middleware";
import type { R2ObjectBody } from "@cloudflare/workers-types";

/** Shape of the Telegram Bot API response we consume. */
interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
}

/**
 * Core logic to send a Telegram message.
 */
export async function sendTelegramNotification(
  payload: { message: string; chatId?: string },
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  requestId: string = "unknown"
): Promise<unknown> {
  const botToken = env.TG_BOT_TOKEN_BINDING;
  const defaultChatId = env.TG_CHAT_ID_BINDING;

  if (!botToken) {
    logger.error(`[${requestId}] TG_BOT_TOKEN_BINDING not configured`);
    throw new Error("Telegram bot token not configured");
  }

  const chatId = payload.chatId || defaultChatId;
  if (!chatId) {
    logger.error(`[${requestId}] No chatId provided and no default configured`);
    throw new Error("Telegram chatId not configured");
  }

  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(telegramApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: payload.message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10000),
  });

  const responseData: TelegramApiResponse = await response.json();

  if (!response.ok) {
    logger.error(`[${requestId}] Telegram API Error`, {
      body: JSON.stringify(responseData),
    });
    throw new Error(
      `Telegram API request failed (${response.status}): ${responseData.description || "Unknown error"}`
    );
  }

  logger.info(`[${requestId}] Telegram API Success Response`, {
    body: JSON.stringify(responseData),
  });

  // Track notification analytics (non-blocking)
  ctx.waitUntil(
    trackAnalytics(env as unknown as AnalyticsEnv, "/track/notification", {
      data: {
        type: "telegram",
        target: chatId,
        success: response.ok,
      },
    })
  );

  return responseData;
}

/**
 * Sends a reply message back to the Telegram chat.
 */
export async function sendTelegramReply(
  chatId: string | number,
  text: string,
  env: Env,
  logger: Logger
): Promise<Response> {
  const botToken = env.TG_BOT_TOKEN_BINDING;
  if (!botToken) {
    logger.error("Telegram Bot Token is not configured.");
    return Errors.internal("Bot token not configured");
  }

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "MarkdownV2",
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const responseBody = await response.json();

    if (!response.ok) {
      logger.error("Error sending Telegram reply", {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
      return Errors.internal("Failed to send reply");
    }

    logger.info("Successfully sent Telegram reply.");
    return createJsonResponse({ success: true, result: responseBody }, 200);
  } catch (error: unknown) {
    logger.error("Network error sending Telegram reply", {
      error: toError(error),
    });
    return Errors.internal("Network error sending reply");
  }
}

/**
 * Fetches the latest trade signal object from R2.
 */
export async function handleGetLatestTradeSignalR2(
  env: Env,
  logger: Logger
): Promise<R2ObjectBody | null> {
  if (!env.UPLOADS_BUCKET) {
    logger.error("R2_BUCKET binding is not configured.");
    return null;
  }

  try {
    logger.info("Listing objects in R2 bucket...");
    const listed = await env.UPLOADS_BUCKET.list({
      limit: 1,
    });

    if (listed.objects.length === 0) {
      logger.info("No objects found in R2 bucket.");
      return null;
    }

    const latestObject = listed.objects[0];
    logger.info(`Found latest object: ${latestObject.key}`);

    const objectBody = await env.UPLOADS_BUCKET.get(latestObject.key);
    if (objectBody === null) {
      logger.error(
        `Failed to retrieve object body for key: ${latestObject.key}`
      );
      return null;
    }

    logger.info(
      `Successfully retrieved object body for key: ${latestObject.key}`
    );
    return objectBody as unknown as R2ObjectBody;
  } catch (error: unknown) {
    logger.error("Error fetching latest trade signal from R2", {
      error: toError(error),
    });
    return null;
  }
}
