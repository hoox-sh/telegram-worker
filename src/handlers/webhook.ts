/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import { Errors, toError } from "@jango-blockchained/hoox-shared/errors";
import {
  trackAnalytics,
  type AnalyticsEnv,
} from "@jango-blockchained/hoox-shared/analytics";
import {
  timingSafeEqual,
  type Logger,
} from "@jango-blockchained/hoox-shared/middleware";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import {
  generateEmbeddings,
  queryEmbeddings,
  insertEmbeddings,
  TelegramMessageMetadata,
  VectorizeMatches,
} from "../logic/rag";
import {
  sendTelegramReply,
  handleGetLatestTradeSignalR2,
} from "../logic/telegram";

/**
 * Escape text for Telegram MarkdownV2 format.
 * Prefixes all special characters with backslash to prevent formatting issues.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\\]()~`>#+\\-=|{}.!])/g, "\\$1");
}

/** Fields from the Telegram getFile API response we consume. */
interface TelegramGetFileResponse {
  ok?: boolean;
  result?: { file_path?: string };
}

/**
 * Handles incoming requests from the Telegram webhook.
 */
export async function handleWebhookRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  // 1. Security Check (fail-closed, timing-safe)
  const secretToken = env.TELEGRAM_SECRET_TOKEN;
  const receivedToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

  // Reject if the secret is not configured OR if the received token
  // does not match. Previously the check was fail-open (only rejected
  // when a secret was set but mismatched), which let any unauthenticated
  // request reach the /kill_on command when the operator had not yet
  // set TELEGRAM_SECRET_TOKEN.
  if (
    !secretToken ||
    !receivedToken ||
    !timingSafeEqual(receivedToken, secretToken)
  ) {
    logger.warn("Invalid or missing Telegram secret token received.");
    return Errors.unauthorized();
  }

  // 2. Parse Telegram Update
  // Telegram PhotoSize type for photo messages
  interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }

  let update: {
    message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      text?: string;
      photo?: TelegramPhotoSize[];
      caption?: string;
      date: number;
    };
    edited_message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      text?: string;
      photo?: TelegramPhotoSize[];
      caption?: string;
      date: number;
    };
  };
  try {
    update = await request.json();
    logger.debug("Received Telegram update", { update });
  } catch (error: unknown) {
    logger.error("Failed to parse Telegram update JSON", {
      error: toError(error),
    });
    return Errors.badRequest("Invalid JSON");
  }

  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.chat.id || !message.message_id) {
    logger.info(
      "Received update without a usable message/chat context. Skipping."
    );
    return new Response("OK", { status: 200 });
  }

  const chatId = message.chat.id;
  const hasPhoto = message.photo && message.photo.length > 0;
  const senderId = message.from?.id ? String(message.from.id) : undefined;

  // 3. Chat ID Authorization Check (FAIL-CLOSED) — before any command/photo work
  // AUTHORIZED_CHAT_IDS must be configured. Without it, any Telegram user who
  // can message the bot could run /kill_on or burn AI credits on photos.
  // Placeholder "__SECRET__" (wrangler template) is treated as unset.
  const authorizedChatIds = env.AUTHORIZED_CHAT_IDS as string | undefined;
  if (
    !authorizedChatIds ||
    authorizedChatIds === "__SECRET__" ||
    !authorizedChatIds.trim()
  ) {
    logger.error(
      "AUTHORIZED_CHAT_IDS not configured — rejecting webhook command (fail-closed)"
    );
    // Return OK so Telegram does not retry; do not execute commands
    return new Response("OK", { status: 200 });
  }
  const allowedIds = authorizedChatIds
    .split(",")
    .map((id: string) => id.trim())
    .filter(Boolean);
  if (allowedIds.length === 0 || !allowedIds.includes(String(chatId))) {
    logger.warn(
      `Unauthorized command from chat ${chatId} (sender: ${senderId || "unknown"})`
    );
    // Silently return OK to not reveal existence of auth filtering
    return new Response("OK", { status: 200 });
  }

  // If message has no text but has a photo, handle as photo/chart
  if (!message.text && hasPhoto) {
    logger.info("Received photo message — processing with AI vision");
    return await handlePhotoMessage(
      message as typeof message & { photo: TelegramPhotoSize[] },
      chatId,
      message.message_id,
      env,
      ctx,
      logger
    );
  }

  // If message has neither text nor photo, skip silently
  if (!message.text && !hasPhoto) {
    logger.info(
      "Received update without usable content (no text or photo). Skipping."
    );
    return new Response("OK", { status: 200 });
  }

  const messageText = message.text!.trim();
  const messageId = String(message.message_id);

  // 4. Analytics Tracking (fire-and-forget)
  ctx.waitUntil(
    trackAnalytics(env as unknown as AnalyticsEnv, "/track/notification", {
      data: {
        type: "telegram_webhook",
        target: String(chatId),
        command: messageText.startsWith("/")
          ? messageText.split(" ")[0]
          : "message",
      },
    })
  );

  // 5. Command Handling & Processing
  try {
    if (messageText === "/start") {
      const welcomeText =
        "Welcome to *Hoox Bot* \\- Your trading assistant\\!\n\n" +
        "*Available Commands:*\n" +
        "• `/start` \\- Show this help message\n" +
        "• `/status` \\- Check system status & kill switch\n" +
        "• `/latest` or `/trades` \\- Latest trade signal\n" +
        "• `/positions` \\- View open positions\n" +
        "• `/search <query>` \\- Search message history\n" +
        "• `/ask <question>` \\- Ask AI about context\n" +
        "• `/kill\\_on` \\- Enable global kill switch\n" +
        "• `/kill\\_off` \\- Disable global kill switch\n\n" +
        "_Any other message will be indexed for future search\\._";
      await sendTelegramReply(chatId, welcomeText, env, logger);
    } else if (messageText === "/status") {
      logger.info("Processing /status command...");
      const killSwitch = await env.CONFIG_KV.get(KVKeys.KV_TRADE_KILL_SWITCH);
      const isKillSwitchActive = killSwitch === "true" || killSwitch === "True";
      const statusIcon = isKillSwitchActive ? "🚫" : "✅";
      const statusText = isKillSwitchActive
        ? "ACTIVE \\- all trading halted"
        : "INACTIVE \\- trading permitted";
      await sendTelegramReply(
        chatId,
        `*Hoox System Status*\n\n` +
          `${statusIcon} *Kill Switch:* ${statusText}\n` +
          `_Last checked: ${new Date().toISOString()}_`,
        env,
        logger
      );
    } else if (messageText === "/latest" || messageText === "/trades") {
      logger.info(`Processing ${messageText} command...`);
      const latestSignalObject = await handleGetLatestTradeSignalR2(
        env,
        logger
      );
      if (latestSignalObject) {
        try {
          const text = await new Response(latestSignalObject.body).text();
          const signalData = JSON.parse(text);
          const formattedSignal = escapeMarkdownV2(
            JSON.stringify(signalData, null, 2)
          );
          await sendTelegramReply(
            chatId,
            `*Latest Trade Signal:*\n\`\`\`json\n${formattedSignal}\n\`\`\``,
            env,
            logger
          );
        } catch (parseError: unknown) {
          logger.error("Failed to parse latest signal JSON", {
            error: toError(parseError),
          });
          await sendTelegramReply(
            chatId,
            "Error: Could not read the latest signal data.",
            env,
            logger
          );
        }
      } else {
        await sendTelegramReply(
          chatId,
          "Could not find any recent trade signals.",
          env,
          logger
        );
      }
    } else if (messageText === "/positions") {
      logger.info("Processing /positions command...");
      await sendTelegramReply(
        chatId,
        "Open positions can be viewed in the Hoox dashboard\\.\n" +
          "Use the dashboard for a detailed view of all active positions and PnL\\.",
        env,
        logger
      );
    } else if (messageText === "/kill_on") {
      logger.info("Processing /kill_on command...");
      await env.CONFIG_KV.put(KVKeys.KV_TRADE_KILL_SWITCH, "true");
      logger.info("Global kill switch engaged via Telegram command");
      await sendTelegramReply(
        chatId,
        "🚫 *Global Kill Switch ENGAGED*\nAll new trade signals will be rejected until the kill switch is disabled\\.",
        env,
        logger
      );
    } else if (messageText === "/kill_off") {
      logger.info("Processing /kill_off command...");
      await env.CONFIG_KV.put(KVKeys.KV_TRADE_KILL_SWITCH, "false");
      logger.info("Global kill switch disengaged via Telegram command");
      await sendTelegramReply(
        chatId,
        "✅ *Global Kill Switch DISABLED*\nTrading signals will be processed normally\\.",
        env,
        logger
      );
    } else if (
      messageText === "/search" ||
      messageText.startsWith("/search ")
    ) {
      const query =
        messageText === "/search" ? "" : messageText.substring(8).trim();
      if (!query) {
        await sendTelegramReply(
          chatId,
          "Please provide a search term after /search.",
          env,
          logger
        );
      } else {
        logger.info(`Processing /search command with query: "${query}"`);
        try {
          const searchResults = await queryEmbeddings(query, env, logger, 5);

          let replyText = `Found ${searchResults.matches.length} results for "_${query}_":\n\n`;
          if (searchResults.matches.length > 0) {
            searchResults.matches.forEach((match, index) => {
              const originalText =
                (match.metadata?.text as string) || "(No text found)";
              const escapedText = escapeMarkdownV2(originalText);
              replyText += `${index + 1}. (${match.score.toFixed(3)}) ${escapedText}\n`;
            });
          } else {
            replyText = `No results found for "_${query}_."`;
          }
          await sendTelegramReply(chatId, replyText, env, logger);
        } catch (searchError: unknown) {
          logger.error("Error searching vectorize during /search", {
            error: toError(searchError),
          });
          await sendTelegramReply(
            chatId,
            "Sorry, I encountered an error searching the message history\\. Please try again later\\.",
            env,
            logger
          );
        }
      }
    } else if (messageText === "/ask" || messageText.startsWith("/ask ")) {
      const question =
        messageText === "/ask" ? "" : messageText.substring(5).trim();
      if (!question) {
        await sendTelegramReply(
          chatId,
          "Please provide a question after /ask\\.",
          env,
          logger
        );
      } else {
        logger.info(`Processing /ask command with question: "${question}"`);
        await sendTelegramReply(
          chatId,
          `_Searching message history for context related to "${question}".`,
          env,
          logger
        );

        let searchResults: VectorizeMatches | null = null;
        try {
          searchResults = await queryEmbeddings(question, env, logger, 5);
        } catch (vectorError: unknown) {
          logger.error("Error querying Vectorize during /ask", {
            error: toError(vectorError),
          });
          await sendTelegramReply(
            chatId,
            "Sorry, I encountered an error searching the message history\\. Please try again later\\.",
            env,
            logger
          );
          return new Response("OK", { status: 200 });
        }

        const contextTexts = searchResults.matches
          .map((match) => match.metadata?.text as string)
          .filter((text) => !!text);

        if (contextTexts.length === 0) {
          await sendTelegramReply(
            chatId,
            `Couldn't find relevant context for "${question}". Try asking differently or indexing more messages.`,
            env,
            logger
          );
        } else {
          const MAX_CONTEXT_LENGTH = 3000;
          let currentLength = 0;
          const limitedContext: string[] = [];
          for (const text of contextTexts) {
            if (currentLength + text.length < MAX_CONTEXT_LENGTH) {
              limitedContext.push(text);
              currentLength += text.length;
            } else {
              break;
            }
          }

          const contextString = limitedContext
            .map((text, i) => `Context ${i + 1}: ${text}`)
            .join("\\n-----\\n");

          const systemPrompt =
            "You are a helpful assistant\\. Answer the user's question based *ONLY* on the provided context snippets from previous messages\\. If the context does not contain the answer, clearly state that you cannot answer based on the provided information\\. Do not add any information not present in the context\\.";
          const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION: ${question}`;

          await sendTelegramReply(
            chatId,
            `_Found ${limitedContext.length} relevant message snippets\\! Asking the AI\\.\\.\\._`,
            env,
            logger
          );
          logger.info(
            `Sending RAG prompt to AI (Context length: ${currentLength} chars):\nSystem: ${systemPrompt}\nUser: ${userPrompt}`
          );

          let aiResponse: { response: string };
          try {
            aiResponse = (await env.AI.run("@cf/meta/llama-3-8b-instruct", {
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            })) as { response: string };
          } catch (aiError: unknown) {
            logger.error("Error calling AI during /ask", {
              error: toError(aiError),
            });
            await sendTelegramReply(
              chatId,
              "Sorry, I encountered an error asking the AI\\. Please try again later\\.",
              env,
              logger
            );
            return new Response("OK", { status: 200 });
          }

          const replyText = escapeMarkdownV2(aiResponse.response);
          await sendTelegramReply(chatId, replyText, env, logger);
        }
      }
    } else {
      logger.info(`Indexing message: "${messageText}"`);
      const embeddings = await generateEmbeddings(messageText, env, logger);
      const metadata: TelegramMessageMetadata = {
        messageId: messageId,
        chatId: String(chatId),
        senderId: senderId,
        timestamp: message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString(),
        text: messageText,
      };
      await insertEmbeddings(embeddings, [metadata], env, logger);
    }

    return new Response("OK", { status: 200 });
  } catch (error: unknown) {
    logger.error("Error processing Telegram message", {
      error: toError(error),
    });
    try {
      await sendTelegramReply(
        chatId || "unknown_chat",
        `An internal error occurred while processing your request.`,
        env,
        logger
      );
    } catch (sendError: unknown) {
      logger.error("Failed to send error notification to user", {
        error: toError(sendError),
      });
    }
    return new Response("OK", { status: 200 });
  }
}

/**
 * Converts a Uint8Array to a base64 string using chunked encoding
 * to avoid the call stack size limit from spreading large arrays.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK_SIZE) as unknown as number[]
    );
  }
  return btoa(binary);
}

/**
 * Handles incoming photo messages from Telegram.
 * Downloads the photo, stores it in R2, and optionally runs AI vision analysis.
 */
async function handlePhotoMessage(
  message: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    photo: {
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }[];
    caption?: string;
    date: number;
  },
  chatId: number,
  messageId: number,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const botToken = env.TG_BOT_TOKEN_BINDING;
  if (!botToken) {
    logger.error("TG_BOT_TOKEN_BINDING not configured for photo download");
    return new Response("OK", { status: 200 });
  }

  try {
    // 1. Get the largest photo (last in the array)
    const largestPhoto = message.photo[message.photo.length - 1];
    const fileId = largestPhoto.file_id;
    const fileExt = largestPhoto.file_id.startsWith("AQA") ? "jpg" : "jpg"; // Telegram uses JPEG

    logger.info(
      `Processing photo: file_id=${fileId}, size=${largestPhoto.width}x${largestPhoto.height}`
    );

    // 2. Get file path from Telegram API
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const getFileResponse = await fetch(getFileUrl, {
      signal: AbortSignal.timeout(30000),
    });
    const getFileData: TelegramGetFileResponse = await getFileResponse.json();

    if (!getFileData.ok || !getFileData.result?.file_path) {
      logger.error("Failed to get file path from Telegram", { getFileData });
      await sendTelegramReply(
        chatId,
        "Sorry, I couldn't download the photo\\. Please try again\\.",
        env,
        logger
      );
      return new Response("OK", { status: 200 });
    }

    const filePath = getFileData.result.file_path;

    // 3. Download the photo from Telegram's CDN
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const photoResponse = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30000),
    });
    if (!photoResponse.ok) {
      logger.error("Failed to download photo from Telegram CDN", {
        status: photoResponse.status,
      });
      await sendTelegramReply(
        chatId,
        "Sorry, I couldn't download the photo\\. Please try again\\.",
        env,
        logger
      );
      return new Response("OK", { status: 200 });
    }

    const photoBlob = await photoResponse.blob();
    const photoArrayBuffer = await photoBlob.arrayBuffer();

    // 4. Store photo in R2 bucket for future reference
    const r2Key = `telegram/photos/${Date.now()}_${messageId}.${fileExt}`;
    if (env.UPLOADS_BUCKET) {
      ctx.waitUntil(
        env.UPLOADS_BUCKET.put(r2Key, photoBlob, {
          httpMetadata: { contentType: `image/${fileExt}` },
          customMetadata: {
            chatId: String(chatId),
            messageId: String(messageId),
            caption: message.caption || "",
            originalFileId: fileId,
          },
        }).then(() => {
          logger.info(`Photo stored in R2: ${r2Key}`);
        })
      );
    }

    // 5. Run AI vision analysis on the photo
    await sendTelegramReply(
      chatId,
      "_Analyzing the image with AI\\.\\.\\._",
      env,
      logger
    );

    // Convert to base64 for Workers AI
    const photoBase64 = uint8ArrayToBase64(new Uint8Array(photoArrayBuffer));
    const dataUri = `data:image/${fileExt};base64,${photoBase64}`;

    const analysisPrompt = message.caption
      ? `Analyze this image in context: "${message.caption}". Describe what you see in detail.`
      : "Describe this image in detail. If it appears to be a trading chart or financial data, analyze the patterns, trends, and key levels visible.";

    let aiResponse: { response?: string };
    try {
      aiResponse = (await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: analysisPrompt },
              {
                type: "image_url",
                image_url: { url: dataUri },
              },
            ],
          },
        ],
        max_tokens: 512,
      })) as { response?: string };
    } catch (aiError: unknown) {
      logger.error("Error calling AI vision model", {
        error: toError(aiError),
      });
      await sendTelegramReply(
        chatId,
        "I received your photo but couldn't analyze it with AI right now\\. It's been saved for later review\\.",
        env,
        logger
      );
      return new Response("OK", { status: 200 });
    }

    const analysisText = aiResponse?.response || "No analysis generated.";

    // Truncate if needed (Telegram has 4096 char limit per message)
    const maxLength = 4000;
    const truncated =
      analysisText.length > maxLength
        ? analysisText.substring(0, maxLength) + "\\..."
        : analysisText;

    const replyText = `*AI Image Analysis:*\n\n${escapeMarkdownV2(truncated)}`;
    await sendTelegramReply(chatId, replyText, env, logger);

    return new Response("OK", { status: 200 });
  } catch (error: unknown) {
    logger.error("Error processing photo message", {
      error: toError(error),
    });
    await sendTelegramReply(
      chatId,
      "An error occurred while processing your photo\\.",
      env,
      logger
    );
    return new Response("OK", { status: 200 });
  }
}
