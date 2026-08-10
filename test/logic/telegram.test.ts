/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, beforeEach, mock, beforeAll } from "bun:test";
import {
  sendTelegramNotification,
  sendTelegramReply,
  handleGetLatestTradeSignalR2,
} from "../../src/logic/telegram";

// Mock global fetch
const mockFetch = mock();

// Create a mock logger
const createMockLogger = () => {
  return {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  };
};

// Mock ExecutionContext
const mockCtx = {
  waitUntil: (p: Promise<any>) => {
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  },
} as unknown as ExecutionContext;

describe("sendTelegramNotification", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "123456789";

  beforeEach(() => {
    mock.restore();
    mockFetch.mockClear();
    mockEnv = {
      TG_BOT_TOKEN_BINDING: TEST_BOT_TOKEN,
      TG_CHAT_ID_BINDING: TEST_CHAT_ID,
    };
    mockLogger = createMockLogger();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  test("sends notification with default chat ID when no chatId provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await sendTelegramNotification(
      { message: "Test message" },
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain(TEST_BOT_TOKEN);
    expect(url).toContain("sendMessage");
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe(TEST_CHAT_ID);
    expect(body.text).toBe("Test message");
    expect(body.parse_mode).toBe("HTML");
  });

  test("sends notification with explicit chatId override", async () => {
    const explicitChatId = "987654321";
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await sendTelegramNotification(
      { message: "Test", chatId: explicitChatId },
      mockEnv,
      mockCtx,
      mockLogger
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe(explicitChatId);
  });

  test("throws error when bot token is not configured", async () => {
    const envWithoutToken = {
      TG_BOT_TOKEN_BINDING: undefined,
      TG_CHAT_ID_BINDING: TEST_CHAT_ID,
    };

    await expect(
      sendTelegramNotification(
        { message: "Test" },
        envWithoutToken,
        mockCtx,
        mockLogger
      )
    ).rejects.toThrow("Telegram bot token not configured");
  });

  test("throws error when no chatId and no default configured", async () => {
    const envWithoutChatId = {
      TG_BOT_TOKEN_BINDING: TEST_BOT_TOKEN,
      TG_CHAT_ID_BINDING: undefined,
    };

    await expect(
      sendTelegramNotification(
        { message: "Test" },
        envWithoutChatId,
        mockCtx,
        mockLogger
      )
    ).rejects.toThrow("Telegram chatId not configured");
  });

  test("throws error on non-ok response from Telegram API", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, description: "Chat not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      sendTelegramNotification(
        { message: "Test" },
        mockEnv,
        mockCtx,
        mockLogger
      )
    ).rejects.toThrow(/Telegram API request failed \(404\): Chat not found/);
  });

  test("throws error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    await expect(
      sendTelegramNotification(
        { message: "Test" },
        mockEnv,
        mockCtx,
        mockLogger
      )
    ).rejects.toThrow();
  });
});

describe("sendTelegramReply", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  const TEST_BOT_TOKEN = "test-bot-token";

  beforeEach(() => {
    mock.restore();
    mockFetch.mockClear();
    mockEnv = {
      TG_BOT_TOKEN_BINDING: TEST_BOT_TOKEN,
    };
    mockLogger = createMockLogger();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  test("returns success response on successful send", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 789 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await sendTelegramReply(
      "123456789",
      "Reply text",
      mockEnv,
      mockLogger
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe("123456789");
    expect(body.text).toBe("Reply text");
    expect(body.parse_mode).toBe("MarkdownV2");
  });

  test("returns internal error when bot token not configured", async () => {
    const envWithoutToken = {
      TG_BOT_TOKEN_BINDING: undefined,
    };

    const response = await sendTelegramReply(
      "123456789",
      "Reply",
      envWithoutToken,
      mockLogger
    );

    expect(response.status).toBe(500);
  });

  test("returns error response on failed send", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await sendTelegramReply(
      "123456789",
      "Reply",
      mockEnv,
      mockLogger
    );

    expect(response.status).toBe(500);
  });

  test("returns error response on network exception", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection timeout"));

    const response = await sendTelegramReply(
      "123456789",
      "Reply",
      mockEnv,
      mockLogger
    );

    expect(response.status).toBe(500);
  });
});

describe("handleGetLatestTradeSignalR2", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  const mockR2Bucket = {
    get: mock(),
    put: mock(),
    list: mock(),
  };

  beforeEach(() => {
    mock.restore();
    mockR2Bucket.list.mockClear();
    mockR2Bucket.get.mockClear();
    mockLogger = createMockLogger();
    mockEnv = {
      UPLOADS_BUCKET: mockR2Bucket,
    };
  });

  test("returns null when R2 binding is not configured", async () => {
    const envWithoutR2 = {
      UPLOADS_BUCKET: undefined,
    };

    const result = await handleGetLatestTradeSignalR2(envWithoutR2, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "R2_BUCKET binding is not configured."
    );
  });

  test("returns null when bucket is empty", async () => {
    // Canonical keys miss, then list under signals/ is empty
    mockR2Bucket.get.mockResolvedValue(null);
    mockR2Bucket.list.mockResolvedValueOnce({ objects: [] });

    const result = await handleGetLatestTradeSignalR2(mockEnv, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "No objects found in R2 bucket under signals/."
    );
  });

  test("returns object body from canonical key", async () => {
    const mockObject = {
      key: "latest_trade_signal.json",
      body: "signal data",
      writeHttpMetadata: mock(),
    };
    mockR2Bucket.get.mockImplementation(async (key: string) => {
      if (key === "latest_trade_signal.json") return mockObject;
      return null;
    });

    const result = await handleGetLatestTradeSignalR2(mockEnv, mockLogger);

    expect(result).toBe(mockObject);
    expect(mockR2Bucket.get).toHaveBeenCalledWith("latest_trade_signal.json");
  });

  test("falls back to signals/ list when canonical keys miss", async () => {
    const mockObject = {
      key: "signals/older.json",
      body: "signal data",
      uploaded: new Date("2026-01-02"),
      writeHttpMetadata: mock(),
    };
    mockR2Bucket.get.mockImplementation(async (key: string) => {
      if (key === "signals/older.json") return mockObject;
      return null;
    });
    mockR2Bucket.list.mockResolvedValueOnce({
      objects: [
        {
          key: "signals/older.json",
          uploaded: new Date("2026-01-02"),
        },
        {
          key: "signals/oldest.json",
          uploaded: new Date("2026-01-01"),
        },
      ],
    });

    const result = await handleGetLatestTradeSignalR2(mockEnv, mockLogger);

    expect(result).toBe(mockObject);
    expect(mockR2Bucket.get).toHaveBeenCalledWith("signals/older.json");
  });

  test("returns null when listed object body is null", async () => {
    mockR2Bucket.get.mockResolvedValue(null);
    mockR2Bucket.list.mockResolvedValueOnce({
      objects: [{ key: "signals/latest.json", uploaded: new Date() }],
    });

    const result = await handleGetLatestTradeSignalR2(mockEnv, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to retrieve object body")
    );
  });

  test("returns null and logs error when R2 operation throws", async () => {
    mockR2Bucket.get.mockRejectedValueOnce(new Error("R2 connection failed"));

    const result = await handleGetLatestTradeSignalR2(mockEnv, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Error fetching latest trade signal from R2",
      expect.objectContaining({ error: "R2 connection failed" })
    );
  });
});

describe("sendTelegramNotification message truncation", () => {
  test("truncates messages longer than Telegram max length", async () => {
    const mockFetch = mock().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      })
    );
    global.fetch = mockFetch as any;
    const mockLogger = {
      info: mock(),
      error: mock(),
      warn: mock(),
      debug: mock(),
    };
    const env = {
      TG_BOT_TOKEN_BINDING: "token",
      TG_CHAT_ID_BINDING: "123",
    };
    const ctx = { waitUntil: () => {} } as any;
    const longMsg = "x".repeat(5000);

    await sendTelegramNotification(
      { message: longMsg },
      env as any,
      ctx,
      mockLogger as any
    );

    expect(mockLogger.warn).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text.endsWith("…")).toBe(true);
  });
});
