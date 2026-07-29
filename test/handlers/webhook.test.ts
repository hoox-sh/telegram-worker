/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { handleWebhookRequest } from "../../src/handlers/webhook";

// Create mock logger
const createMockLogger = () => {
  return {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  };
};

// Mock global fetch
const mockFetch = mock();

describe("handleWebhookRequest", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mock.restore();
    mockLogger = createMockLogger();
    mockCtx = {
      waitUntil: (p: Promise<any>) => {
        if (p && typeof p.catch === "function") {
          p.catch(() => {});
        }
      },
    } as unknown as ExecutionContext;

    mockEnv = {
      TELEGRAM_SECRET_TOKEN: "test-webhook-secret",
      TG_BOT_TOKEN_BINDING: "test-bot-token",
      // Fail-closed chat allowlist — default authorized chat used by most fixtures
      AUTHORIZED_CHAT_IDS: "987654321",
      CONFIG_KV: {
        get: mock().mockResolvedValue(null),
        put: mock().mockResolvedValue(undefined),
      },
      AI: {
        run: mock().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }), // Default: return embeddings
      },
      VECTORIZE_INDEX: {
        insert: mock().mockResolvedValue({ success: true }),
        query: mock().mockResolvedValue({ matches: [] }),
      },
      UPLOADS_BUCKET: {
        put: mock().mockResolvedValue(undefined),
      },
    };
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  test("returns 401 when webhook secret is not configured (fail-closed)", async () => {
    // Regression test for the 2026-06-27 worker audit C-4 finding.
    // The webhook must reject ALL requests when TELEGRAM_SECRET_TOKEN
    // is not set, not just the ones with a wrong secret. This prevents
    // unauthenticated callers from reaching /kill_on and other operator
    // commands during initial deployment or after a secret rotation.
    const envWithoutSecret = {
      ...mockEnv,
      TELEGRAM_SECRET_TOKEN: undefined,
    };

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      envWithoutSecret,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(401);
  });

  test("returns 401 when received token is missing but secret is configured", async () => {
    // The header must be present when the secret is configured. The
    // fail-closed check is symmetric: missing token == wrong token.
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(401);
  });

  test("returns 401 when received token is missing but secret is configured", async () => {
    // The header must be present when the secret is configured. The
    // fail-closed check is symmetric: missing token == wrong token.
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(401);
  });

  test("returns 401 when webhook secret doesn't match", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 when JSON is invalid", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: "not valid json",
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(400);
  });

  test("returns 200 for message without required fields", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({ update_id: 1 }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });

  test("processes /start command", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/start",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });

  test("silently returns 200 when AUTHORIZED_CHAT_IDS is not configured (fail-closed)", async () => {
    mockEnv.AUTHORIZED_CHAT_IDS = undefined;
    const putMock = mockEnv.CONFIG_KV.put;

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/kill_on",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    // Must not execute kill switch without an allowlist
    expect(putMock).not.toHaveBeenCalled();
  });

  test("silently returns 200 for unauthorized chat", async () => {
    mockEnv.AUTHORIZED_CHAT_IDS = "111,222";

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 333, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/start",
          from: { id: 333, is_bot: false, first_name: "Evil" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 200 when message has no text and no photo", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });

  test("should search vectorize and return results", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [
        {
          id: "1",
          score: 0.95,
          metadata: { text: "Bitcoin price prediction" },
        },
        { id: "2", score: 0.87, metadata: { text: "ETH analysis" } },
      ],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 200,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search Bitcoin price",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Found 2 results");
    expect(fetchBody.text).toContain("Bitcoin price prediction");
  });

  test("should return error for empty search query", async () => {
    mockFetch.mockClear();

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 201,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search ",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Please provide a search term");
  });

  test("should return no results message when search has no matches", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({ matches: [] });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 202,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search nonexistent query",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("No results found");
  });

  test("should handle vectorize query error gracefully", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock().mockRejectedValue(new Error("AI error"));

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 203,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search test query",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("error searching");
  });

  test("should query vectorize and respond with AI answer", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock()
      .mockResolvedValueOnce({ data: [[0.1, 0.2, 0.3]] }) // For generateEmbeddings
      .mockResolvedValueOnce({
        response: "Based on recent messages, Bitcoin dropped 5% today.",
      }); // For LLM
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [
        {
          id: "1",
          score: 0.95,
          metadata: { text: "Bitcoin dropped 5% today" },
        },
        {
          id: "2",
          score: 0.87,
          metadata: { text: "Ethereum showing bullish signals" },
        },
      ],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 300,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What happened to Bitcoin?",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("should return error for empty question", async () => {
    mockFetch.mockClear();

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 301,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask ",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Please provide a question");
  });

  test("should return message when no context found", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({ matches: [] });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 302,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What is the meaning of life?",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("Couldn't find relevant context");
  });

  test("should handle AI error gracefully", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock()
      .mockResolvedValueOnce({ data: [[0.1, 0.2, 0.3]] }) // For generateEmbeddings
      .mockRejectedValueOnce(new Error("AI service unavailable")); // For LLM
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [{ id: "1", score: 0.95, metadata: { text: "Test context" } }],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 303,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What is the price?",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("error asking the AI");
  });

  test("should handle vectorize query error during /ask", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock().mockRejectedValue(new Error("AI error"));

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 304,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask Test question",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("error searching");
  });

  // ---------------------------------------------------------------------------
  // Coverage: branching at webhook.ts:83-116 (message vs edited_message,
  // chat.id, message_id, text, photo). These tests exercise the previously
  // uncovered guard clauses and the photo/AI-vision dispatch path.
  // ---------------------------------------------------------------------------

  test("should skip update with neither text nor photo", async () => {
    // Arrange — message with no text and no photo triggers the silent-skip
    // branch at webhook.ts:109-114 (returns 200 OK with no processing).
    mockFetch.mockClear();
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 500,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    // Act
    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    // Assert — silent skip: 200 OK, empty body, no downstream calls
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("OK");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEnv.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(mockEnv.AI.run).not.toHaveBeenCalled();
  });

  test("should handle edited_message path", async () => {
    // Arrange — update uses `edited_message` instead of `message`, exercising
    // the fallback at webhook.ts:83. A /status command verifies that the
    // edited message still flows through the command handler.
    mockFetch.mockClear();
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12346,
        edited_message: {
          message_id: 600,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/status",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    // Act
    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    // Assert — /status handler ran via the edited_message branch
    expect(response.status).toBe(200);
    expect(mockEnv.CONFIG_KV.get).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("Hoox System Status");
  });

  test("should skip when chat.id is missing", async () => {
    // Arrange — message has a chat object but no `chat.id`, failing the guard
    // at webhook.ts:84. Handler should silently return 200 OK.
    mockFetch.mockClear();
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12347,
        message: {
          message_id: 700,
          chat: { type: "private" }, // No `id` field
          date: Math.floor(Date.now() / 1000),
          text: "/status",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    // Act
    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    // Assert — silent skip due to missing chat.id
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("OK");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEnv.CONFIG_KV.get).not.toHaveBeenCalled();
  });

  test("should skip when message_id is missing", async () => {
    // Arrange — message has chat.id but no message_id, failing the guard at
    // webhook.ts:84. Handler should silently return 200 OK.
    mockFetch.mockClear();
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12348,
        message: {
          // No `message_id` field
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/status",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    // Act
    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    // Assert — silent skip due to missing message_id
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("OK");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEnv.CONFIG_KV.get).not.toHaveBeenCalled();
  });

  test("should handle photo-only message (no text + photo)", async () => {
    // Arrange — message with no text but a photo array triggers the
    // AI-vision/photo branch at webhook.ts:96-106. Stub fetch for getFile,
    // file download, and Telegram replies; stub AI.run for the vision model.
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(
        // 1) Telegram getFile API call
        new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: "photos/file_123.jpg" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        // 2) File download — binary blob
        new Response(fakeJpeg, { status: 200 })
      )
      .mockResolvedValueOnce(
        // 3) sendTelegramReply("Analyzing...")
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 555 } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        // 4) sendTelegramReply(final analysis)
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 556 } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    mockEnv.AI.run = mock().mockResolvedValue({
      response: "A bullish chart pattern visible on BTC/USDT 4h timeframe.",
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12349,
        message: {
          message_id: 800,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          // No `text` field — photo-only path
          photo: [
            {
              file_id: "AQA_small",
              file_unique_id: "uniq_small",
              width: 90,
              height: 60,
              file_size: 1200,
            },
            {
              file_id: "AQA_large",
              file_unique_id: "uniq_large",
              width: 800,
              height: 600,
              file_size: 48000,
            },
          ],
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    // Act
    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    // Assert — photo path completed: R2 received the upload, vision model ran
    expect(response.status).toBe(200);
    expect(mockEnv.UPLOADS_BUCKET.put).toHaveBeenCalled();
    const putArgs = mockEnv.UPLOADS_BUCKET.put.mock.calls[0];
    expect(putArgs[0]).toContain("telegram/photos/");
    expect(putArgs[0]).toContain("_800.jpg");
    expect(mockEnv.AI.run).toHaveBeenCalled();
    const aiArgs = mockEnv.AI.run.mock.calls[0];
    expect(aiArgs[0]).toContain("llama-3.2-11b-vision-instruct");
  });
});
