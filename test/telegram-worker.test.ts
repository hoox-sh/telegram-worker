/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
  afterEach,
  beforeAll,
  Mock,
} from "bun:test";
import telegramWorker from "../src/index.js";
import type {
  KVNamespace,
  R2Bucket,
  VectorizeIndex,
  Fetcher,
} from "@cloudflare/workers-types";

// --- Mock Types ---
interface MockKV {
  // Using any for simplicity
  get: Mock<() => Promise<any>>;
  put: Mock<() => Promise<any>>;
  list?: Mock<() => Promise<any>>;
  delete?: Mock<() => Promise<any>>;
}
interface MockAI {
  // Using any as @cloudflare/ai types might not be installed
  run: Mock<(...args: any[]) => Promise<any>>;
}
interface MockVectorize {
  // Simplified
  insert: Mock<(...args: any[]) => Promise<any>>;
  query: Mock<(...args: any[]) => Promise<any>>;
}
interface MockR2 {
  // Simplified
  get: Mock<(...args: any[]) => Promise<any>>;
  put: Mock<(...args: any[]) => Promise<any>>;
  head?: Mock<(...args: any[]) => Promise<any>>;
  delete?: Mock<(...args: any[]) => Promise<any>>;
  list?: Mock<(...args: any[]) => Promise<any>>;
}

// Define the actual Env structure used by the worker
// Use real types here
interface WorkerEnv {
  INTERNAL_KEY_BINDING?: Fetcher;
  TG_BOT_TOKEN_BINDING: Fetcher;
  TELEGRAM_SECRET_TOKEN?: string;
  TG_CHAT_ID_BINDING?: Fetcher;
  CONFIG_KV: KVNamespace;
  REPORT_KV?: KVNamespace;
  AI: any;
  VECTORIZE_INDEX: VectorizeIndex;
  UPLOADS_BUCKET: R2Bucket;
}

// Define a type for the mocked environment object we create in tests
type MockEnvForTest = {
  INTERNAL_KEY_BINDING?: string | null;
  TG_BOT_TOKEN_BINDING?: string | null;
  TELEGRAM_SECRET_TOKEN?: string;
  TG_CHAT_ID_BINDING?: string | null;
  AUTHORIZED_CHAT_IDS?: string | null;
  CONFIG_KV: MockKV;
  REPORT_KV?: MockKV;
  AI: MockAI;
  VECTORIZE_INDEX: MockVectorize;
  UPLOADS_BUCKET: MockR2;
};

// Mock environment setup function
const createMockEnv = (secrets: {
  internalKey?: string | null;
  botToken?: string | null;
  chatId?: string | null;
  webhookSecret?: string | null;
  authorizedChatIds?: string | null;
}): MockEnvForTest => {
  const createR2Mock = (): MockR2 => ({
    get: mock(),
    put: mock(),
    head: mock(),
    delete: mock(),
    list: mock().mockResolvedValue({
      objects: [{ key: "latest_trade_signal.json" }],
    }),
  });

  return {
    INTERNAL_KEY_BINDING:
      secrets.internalKey !== undefined ? secrets.internalKey : undefined,
    TG_BOT_TOKEN_BINDING:
      secrets.botToken === undefined ? null : secrets.botToken,
    TELEGRAM_SECRET_TOKEN:
      secrets.webhookSecret === null ? undefined : secrets.webhookSecret,
    AUTHORIZED_CHAT_IDS:
      secrets.authorizedChatIds !== undefined
        ? secrets.authorizedChatIds
        : undefined,
    TG_CHAT_ID_BINDING:
      secrets.chatId !== undefined ? secrets.chatId : undefined,
    CONFIG_KV: {
      get: mock().mockImplementation((key: string) => {
        if (key === "bot:default_chat_id")
          return Promise.resolve(secrets.chatId);
        return Promise.resolve(null);
      }),
      put: mock().mockResolvedValue(undefined),
      list: mock().mockResolvedValue({ keys: [] }),
      delete: mock().mockResolvedValue(undefined),
      getWithMetadata: mock().mockResolvedValue({
        value: null,
        metadata: null,
      }),
    } as MockKV,
    REPORT_KV: {
      get: mock().mockResolvedValue(null),
      put: mock().mockResolvedValue(undefined),
      list: mock().mockResolvedValue({ keys: [] }),
      delete: mock().mockResolvedValue(undefined),
      getWithMetadata: mock().mockResolvedValue({
        value: null,
        metadata: null,
      }),
    } as MockKV,
    AI: mock(),
    VECTORIZE_INDEX: {
      insert: mock(),
      query: mock(),
      describeIndex: mock().mockResolvedValue({}),
    } as MockVectorize,
    UPLOADS_BUCKET: createR2Mock(),
  } as any;
};

const PROCESS_ENDPOINT = "/alert";

// Mock ExecutionContext with waitUntil for tests
// Cloudflare Workers ctx.waitUntil returns void, not Promise — the runtime
// internally extends the worker lifetime. Our mock swallows rejections to
// match waitUntil's fire-and-forget semantics without floating promises.
// Guards against non-Promise values (e.g., trackAnalytics returns undefined
// when ANALYTICS_SERVICE binding is missing).
const mockCtx = {
  waitUntil: (p: Promise<any>) => {
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  },
} as any;

describe("Telegram Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  let mockEnv: MockEnvForTest;
  let fetchMock: ReturnType<typeof mock>;
  const validNotification = { message: "...", chatId: 123 };
  const validNotificationDefaultChat = { message: "..." };

  beforeEach(() => {
    mock.restore();
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    fetchMock = mock(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  test("accepts TELEGRAM_INTERNAL_KEY_BINDING without legacy INTERNAL_KEY_BINDING", async () => {
    mockEnv = createMockEnv({
      internalKey: null,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    (mockEnv as Record<string, unknown>).TELEGRAM_INTERNAL_KEY_BINDING =
      "telegram-scoped-key";

    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": "telegram-scoped-key",
        },
        body: JSON.stringify({ message: "scoped key alert" }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
  });

  test("rejects request with invalid internal key", async () => {
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      internalKey: null,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: { "X-Internal-Key": "invalid-key" },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: "invalid-key",
          requestId: "test-req-1",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    // INTERNAL_KEY_BINDING is null → requireInternalAuth rejects with 401
    // The middleware response uses the key name in the error message
    expect(response.status).toBe(401);
    const responseData = (await response.json()) as { error: string };
    expect(responseData.error).toContain("not configured");
  });

  test("rejects request if internalAuthKey doesn't match secret", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: "wrong-key",
          requestId: "test-req-2",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(401);
    const responseData = (await response.json()) as { error: string };
    // Header-based auth returns "Unauthorized" before body-level auth check
    expect(responseData.error).toContain("Unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends telegram message with explicit chat ID", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-1",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    const responseData = (await response.json()) as { success: boolean };
    expect(responseData.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(fetchCallArgs[0]).toContain(TEST_BOT_TOKEN);
  });

  test("sends telegram message with default chat ID from binding", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotificationDefaultChat,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-2",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    const responseData = (await response.json()) as { success: boolean };
    expect(responseData.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(fetchCallArgs[0]).toContain(TEST_BOT_TOKEN);
    const fetchBody = JSON.parse(fetchCallArgs[1].body);
    expect(fetchBody.chat_id).toBe(TEST_CHAT_ID);
    expect(fetchBody.text).toBe(validNotificationDefaultChat.message);
  });

  test("returns error if default chat ID binding fails and no chat ID in request", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: null,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotificationDefaultChat,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-3",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(500);
    const responseData = (await response.json()) as { error: string };
    expect(responseData.error).toContain("Telegram chatId not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns error if bot token binding fails", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: null,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-4",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(500);
    const responseData = (await response.json()) as { error: string };
    expect(responseData.error).toContain("Telegram bot token not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("handles Telegram API fetch errors", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    fetchMock.mockRejectedValue(new Error("Network Error"));
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-5",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(500);
    const responseData = (await response.json()) as { error: string };
    expect(responseData.error).toContain("Network Error");
  });

  test("handles non-200 response from Telegram API", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined,
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, description: "Chat not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );
    const request = new Request(
      `https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          payload: validNotification,
          internalAuthKey: TEST_INTERNAL_KEY,
          requestId: "req-6",
        }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(500);
    const responseData = (await response.json()) as { error: string };
    expect(responseData.error).toContain("Telegram API request failed");
    expect(responseData.error).toContain("(404)");
    expect(responseData.error).toContain("Chat not found");
  });
});

describe("Telegram Worker Helpers", () => {
  let mockEnv: MockEnvForTest;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  const mockAiRun = mock();
  const mockVectorizeInsert = mock();
  const mockVectorizeQuery = mock();
  const mockR2Get = mock();

  beforeEach(() => {
    mock.restore();
    mockAiRun.mockClear();
    mockVectorizeInsert.mockClear();
    mockVectorizeQuery.mockClear();
    mockR2Get.mockClear();
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      internalKey: undefined,
      webhookSecret: undefined,
    });
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;
    global.fetch = mock() as unknown as typeof global.fetch;
  });

  let generateEmbeddingsFn: (
    text: string | string[],
    env: any
  ) => Promise<number[][]>;
  let insertEmbeddingsFn: (
    vectors: number[][],
    metadata: any[],
    env: any
  ) => Promise<void>;
  let queryEmbeddingsFn: (
    queryText: string,
    env: any,
    topK?: number
  ) => Promise<any>;
  let handleGetLatestTradeSignalR2Fn: (env: any) => Promise<any | null>;

  // Mock logger for testing
  const mockLogger = {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  };

  beforeAll(async () => {
    const module = await import("../src/index.js");
    // Wrap all functions to provide the logger
    const originalGenerateEmbeddings = module.generateEmbeddings;
    generateEmbeddingsFn = (text: string | string[], env: any) =>
      originalGenerateEmbeddings(text, env, mockLogger);

    const originalInsertEmbeddings = module.insertEmbeddings;
    insertEmbeddingsFn = (vectors: number[][], metadata: any[], env: any) =>
      originalInsertEmbeddings(vectors, metadata, env, mockLogger);

    const originalQueryEmbeddings = module.queryEmbeddings;
    queryEmbeddingsFn = (queryText: string, env: any, topK?: number) =>
      originalQueryEmbeddings(queryText, env, mockLogger, topK);

    const originalHandleGetLatestTradeSignalR2 =
      module.handleGetLatestTradeSignalR2;
    handleGetLatestTradeSignalR2Fn = (env: any) =>
      originalHandleGetLatestTradeSignalR2(env, mockLogger);
  });

  describe("generateEmbeddings", () => {
    test("should call AI binding and return embeddings", async () => {
      const inputText = "Test message";
      const mockEmbedding = [[0.1, 0.2, 0.3]];
      mockAiRun.mockResolvedValue({ data: mockEmbedding });
      const result = await generateEmbeddingsFn(inputText, mockEnv as any);
      expect(result).toEqual(mockEmbedding);
      expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
        text: inputText,
      });
    });
    test("should throw error if AI binding is missing", async () => {
      const envWithoutAI = {
        ...mockEnv,
        AI: undefined,
      } as unknown as WorkerEnv;
      await expect(generateEmbeddingsFn("Test", envWithoutAI)).rejects.toThrow(
        "AI service not available."
      );
    });
    test("should throw error if AI run fails", async () => {
      const error = new Error("AI API Error");
      mockAiRun.mockRejectedValue(error);
      await expect(
        generateEmbeddingsFn("Test", mockEnv as unknown as WorkerEnv)
      ).rejects.toThrow(`Failed to generate embeddings: ${error.message}`);
    });
    test("should throw error if AI response format is invalid", async () => {
      mockAiRun.mockResolvedValue({ invalid: "structure" });
      await expect(
        generateEmbeddingsFn("Test", mockEnv as unknown as WorkerEnv)
      ).rejects.toThrow("Failed to parse embeddings from AI response.");
    });
  });

  describe("insertEmbeddings", () => {
    const vectors = [[0.1], [0.2]];
    const metadata = [
      { messageId: "m1", text: "t1" },
      { messageId: "m2", text: "t2" },
    ];
    test("should call Vectorize index insert with correct data", async () => {
      mockVectorizeInsert.mockResolvedValue({ success: true, count: 2 });
      await insertEmbeddingsFn(
        vectors,
        metadata,
        mockEnv as unknown as WorkerEnv
      );
      expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
      expect(mockVectorizeInsert).toHaveBeenCalledWith([
        { id: "m1", values: [0.1], metadata: metadata[0] },
        { id: "m2", values: [0.2], metadata: metadata[1] },
      ]);
    });
    test("should throw error if Vectorize binding is missing", async () => {
      const envWithoutVec = {
        ...mockEnv,
        VECTORIZE_INDEX: undefined,
      } as unknown as WorkerEnv;
      await expect(
        insertEmbeddingsFn(vectors, metadata, envWithoutVec)
      ).rejects.toThrow("Vectorize service not available.");
    });
    test("should throw error if vector and metadata counts mismatch", async () => {
      await expect(
        insertEmbeddingsFn(
          vectors,
          [metadata[0]],
          mockEnv as unknown as WorkerEnv
        )
      ).rejects.toThrow(
        "Number of vectors must match number of metadata objects."
      );
    });
    test("should handle Vectorize insert error", async () => {
      const error = new Error("Vectorize Insert Failed");
      mockVectorizeInsert.mockRejectedValue(error);
      await expect(
        insertEmbeddingsFn(vectors, metadata, mockEnv as unknown as WorkerEnv)
      ).rejects.toThrow(`Failed to insert embeddings: ${error.message}`);
    });
    test("should do nothing if vectors array is empty", async () => {
      await insertEmbeddingsFn([], [], mockEnv as unknown as WorkerEnv);
      expect(mockVectorizeInsert).not.toHaveBeenCalled();
    });
  });

  describe("queryEmbeddings", () => {
    const queryText = "Search query";
    const queryEmbedding = [[0.5, 0.6]];
    const mockMatches = { matches: [{ id: "m1", score: 0.9, metadata: {} }] };
    beforeEach(() => {
      mockAiRun.mockResolvedValue({ data: queryEmbedding });
      mockVectorizeQuery.mockResolvedValue(mockMatches);
    });
    test("should generate query embedding and call Vectorize query", async () => {
      const result = await queryEmbeddingsFn(
        queryText,
        mockEnv as unknown as WorkerEnv,
        5
      );
      expect(result).toEqual(mockMatches);
      expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
        text: queryText,
      });
      expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], {
        topK: 5,
        returnMetadata: true,
      });
    });
    test("should use default topK if not provided", async () => {
      await queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv);
      expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], {
        topK: 3,
        returnMetadata: true,
      });
    });
    test("should throw if AI binding is missing", async () => {
      const envWithoutAI = {
        ...mockEnv,
        AI: undefined,
      } as unknown as WorkerEnv;
      await expect(queryEmbeddingsFn(queryText, envWithoutAI)).rejects.toThrow(
        "AI service not available for query embedding."
      );
    });
    test("should throw if Vectorize binding is missing", async () => {
      const envWithoutVec = {
        ...mockEnv,
        VECTORIZE_INDEX: undefined,
      } as unknown as WorkerEnv;
      await expect(queryEmbeddingsFn(queryText, envWithoutVec)).rejects.toThrow(
        "Vectorize service not available."
      );
    });
    test("should throw if query embedding generation fails", async () => {
      const aiError = new Error("AI Fail");
      mockAiRun.mockRejectedValue(aiError);
      await expect(
        queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv)
      ).rejects.toThrow(
        `Failed to query embeddings: Failed to generate embeddings: ${aiError.message}`
      );
      expect(mockVectorizeQuery).not.toHaveBeenCalled();
    });
    test("should throw if Vectorize query fails", async () => {
      const vectorizeError = new Error("Vectorize Fail");
      mockVectorizeQuery.mockRejectedValue(vectorizeError);
      await expect(
        queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv)
      ).rejects.toThrow(
        `Failed to query embeddings: ${vectorizeError.message}`
      );
    });
  });

  describe("handleGetLatestTradeSignalR2", () => {
    test("should get object from R2 bucket", async () => {
      const mockR2Object = {
        body: "latest signal data",
        writeHttpMetadata: mock(),
      };
      mockR2Get.mockResolvedValue(mockR2Object);
      const result = await handleGetLatestTradeSignalR2Fn(
        mockEnv as unknown as WorkerEnv
      );
      expect(result).toBe(mockR2Object);
      expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
    });
    test("should return null if R2 binding is missing", async () => {
      const envWithoutR2 = {
        ...mockEnv,
        UPLOADS_BUCKET: undefined,
      } as unknown as WorkerEnv;
      const result = await handleGetLatestTradeSignalR2Fn(envWithoutR2);
      expect(result).toBeNull();
      expect(mockR2Get).not.toHaveBeenCalled();
    });
    test("should return null if object not found in R2", async () => {
      mockR2Get.mockResolvedValue(null);
      const result = await handleGetLatestTradeSignalR2Fn(
        mockEnv as unknown as WorkerEnv
      );
      expect(result).toBeNull();
      expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
    });
    test("should return null if R2 get fails", async () => {
      const error = new Error("R2 Get Failed");
      mockR2Get.mockRejectedValue(error);
      const result = await handleGetLatestTradeSignalR2Fn(
        mockEnv as unknown as WorkerEnv
      );
      expect(result).toBeNull();
    });
  });
});

describe("Telegram Worker Webhook Handler (/webhook)", () => {
  let mockEnv: MockEnvForTest;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  const WEBHOOK_SECRET = "test-webhook-secret";
  const WEBHOOK_ENDPOINT = "/webhook";
  const mockAiRun = mock();
  const mockVectorizeInsert = mock();
  const mockVectorizeQuery = mock();
  const mockR2Get = mock();
  const mockFetch = mock();

  beforeEach(() => {
    mock.restore();
    // Clear call counts for module-level mocks (mock.restore doesn't reset standalone mocks)
    mockAiRun.mockClear();
    mockVectorizeInsert.mockClear();
    mockVectorizeQuery.mockClear();
    mockR2Get.mockClear();
    mockFetch.mockClear();
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: WEBHOOK_SECRET,
      internalKey: undefined,
      // Fail-closed chat allowlist — matches chatId 987654321 used by fixtures
      authorizedChatIds: "987654321",
    });
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockAiRun.mockResolvedValue({ data: [[0.1]] });
    mockVectorizeInsert.mockResolvedValue({ success: true, count: 1 });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), {
        status: 200,
      })
    );
    mockR2Get.mockResolvedValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  test("should reject request if webhook secret is missing in header", async () => {
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error).toBe("Unauthorized");
  });

  test("should reject request if webhook secret in header is incorrect", async () => {
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
        },
        body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error).toBe("Unauthorized");
  });

  test("should reject request if webhook secret does not match", async () => {
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      internalKey: undefined,
      webhookSecret: "EXPECTED_SECRET",
    });
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "WRONG_SECRET",
        },
        body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error).toBe("Unauthorized");
  });

  test("should process valid text message and generate/insert embeddings", async () => {
    const messageText = "This is a test message";
    const chatId = 987654321;
    const messageId = 555;
    const date = Math.floor(Date.now() / 1000);
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "private" },
        date: date,
        text: messageText,
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAiRun).toHaveBeenCalledTimes(1);
    expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: messageText,
    });
    expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
    const insertArgs = mockVectorizeInsert.mock.calls[0][0];
    expect(insertArgs).toHaveLength(1);
    expect(insertArgs[0].id).toBe(String(messageId));
    expect(insertArgs[0].values).toEqual([0.1]);
    expect(insertArgs[0].metadata).toEqual(
      expect.objectContaining({
        messageId: String(messageId),
        chatId: String(chatId),
        text: messageText,
        timestamp: expect.any(String),
      })
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("/start command should return welcome message", async () => {
    const chatId = 987654321;
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 100,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/start",
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Should NOT vectorize /start text
    expect(mockAiRun).not.toHaveBeenCalled();
    expect(mockVectorizeInsert).not.toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.chat_id).toBe(chatId);
    expect(fetchBody.text).toContain("Welcome");
    expect(fetchBody.text).toContain("/status");
    expect(fetchBody.text).toContain("/kill");
  });

  test("/status command should check kill switch in CONFIG_KV", async () => {
    const chatId = 987654321;
    mockEnv.CONFIG_KV.get = mock().mockImplementation((key: string) => {
      if (key === "trade:kill_switch") return Promise.resolve("true");
      return Promise.resolve(null);
    });
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 101,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/status",
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.text).toContain("Kill Switch");
    expect(fetchBody.text).toContain("ACTIVE");
    expect(mockAiRun).not.toHaveBeenCalled();
  });

  test("/kill_on command should write kill switch to CONFIG_KV", async () => {
    const chatId = 987654321;
    const kvPutMock = mock().mockResolvedValue(undefined);
    mockEnv.CONFIG_KV.put = kvPutMock;
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 102,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/kill_on",
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kvPutMock).toHaveBeenCalledWith("trade:kill_switch", "true");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.text).toContain("ENGAGED");
    expect(mockAiRun).not.toHaveBeenCalled();
  });

  test("/kill_off command should write false to CONFIG_KV", async () => {
    const chatId = 987654321;
    const kvPutMock = mock().mockResolvedValue(undefined);
    mockEnv.CONFIG_KV.put = kvPutMock;
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 103,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/kill_off",
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kvPutMock).toHaveBeenCalledWith("trade:kill_switch", "false");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.text).toContain("DISABLED");
  });

  test("should reject unauthorized chat when AUTHORIZED_CHAT_IDS is set", async () => {
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: WEBHOOK_SECRET,
      internalKey: undefined,
      authorizedChatIds: "111,222",
    });
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const chatId = 333; // Not in authorized list
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 104,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/status",
        from: { id: 333, is_bot: false, first_name: "Evil" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    // Silently returns 200 with no processing
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No fetch to Telegram API, no AI, no Vectorize
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAiRun).not.toHaveBeenCalled();
    expect(mockVectorizeInsert).not.toHaveBeenCalled();
  });

  test("should allow authorized chat when AUTHORIZED_CHAT_IDS is set", async () => {
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: WEBHOOK_SECRET,
      internalKey: undefined,
      authorizedChatIds: "111,222",
    });
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const chatId = 111; // In authorized list
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: 105,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/status",
        from: { id: 111, is_bot: false, first_name: "Admin" },
      },
    };
    const request = new Request(
      `https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(webhookBody),
      }
    );
    const response = await telegramWorker.fetch(
      request as any,
      mockEnv as any,
      mockCtx
    );
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Should process command normally
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
