/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, beforeEach, mock, beforeAll } from "bun:test";
import {
  generateEmbeddings,
  insertEmbeddings,
  queryEmbeddings,
  TelegramMessageMetadata,
  VectorizeMatches,
} from "../../src/logic/rag";

// Create mock logger
const createMockLogger = () => {
  return {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  };
};

describe("generateEmbeddings", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockAI: { run: ReturnType<typeof mock> };

  beforeEach(() => {
    mock.restore();
    mockLogger = createMockLogger();
    mockAI = { run: mock() };
    mockEnv = { AI: mockAI };
  });

  test("should generate embeddings for a single text string", async () => {
    const mockEmbedding = [[0.1, 0.2, 0.3, 0.4, 0.5]];
    mockAI.run.mockResolvedValueOnce({ data: mockEmbedding });

    const result = await generateEmbeddings(
      "test message",
      mockEnv,
      mockLogger
    );

    expect(result).toEqual(mockEmbedding);
    expect(mockAI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: "test message",
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Generating embeddings for input text..."
    );
  });

  test("should generate embeddings for an array of texts", async () => {
    const mockEmbeddings = [
      [0.1, 0.2],
      [0.3, 0.4, 0.5],
    ];
    mockAI.run.mockResolvedValueOnce({ data: mockEmbeddings });

    const result = await generateEmbeddings(
      ["message 1", "message 2"],
      mockEnv,
      mockLogger
    );

    expect(result).toEqual(mockEmbeddings);
    expect(mockAI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: ["message 1", "message 2"],
    });
  });

  test("should throw error when AI binding is not configured", async () => {
    const envWithoutAI = { AI: undefined };

    await expect(
      generateEmbeddings("test", envWithoutAI, mockLogger)
    ).rejects.toThrow("AI service not available.");
  });

  test("should throw error when AI response has invalid structure", async () => {
    mockAI.run.mockResolvedValueOnce({ invalid: "structure" });

    await expect(
      generateEmbeddings("test", mockEnv, mockLogger)
    ).rejects.toThrow("Failed to parse embeddings from AI response.");
  });

  test("should throw error when AI response data is not an array", async () => {
    mockAI.run.mockResolvedValueOnce({ data: "not an array" });

    await expect(
      generateEmbeddings("test", mockEnv, mockLogger)
    ).rejects.toThrow("Failed to parse embeddings from AI response.");
  });

  test("should throw error when AI run throws", async () => {
    mockAI.run.mockRejectedValueOnce(new Error("AI API Error"));

    await expect(
      generateEmbeddings("test", mockEnv, mockLogger)
    ).rejects.toThrow(/Failed to generate embeddings: AI API Error/);
  });
});

describe("insertEmbeddings", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockVectorize: {
    insert: ReturnType<typeof mock>;
    describeIndex: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mock.restore();
    mockLogger = createMockLogger();
    mockVectorize = {
      insert: mock(),
      describeIndex: mock().mockResolvedValue({}),
    };
    mockEnv = { VECTORIZE_INDEX: mockVectorize };
  });

  test("should insert embeddings with correct metadata mapping", async () => {
    const vectors = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const metadata: TelegramMessageMetadata[] = [
      {
        messageId: "msg1",
        chatId: "chat1",
        timestamp: "2024-01-01T00:00:00Z",
        text: "text1",
      },
      {
        messageId: "msg2",
        chatId: "chat2",
        timestamp: "2024-01-02T00:00:00Z",
        text: "text2",
      },
    ];
    mockVectorize.insert.mockResolvedValueOnce({ success: true, count: 2 });

    await insertEmbeddings(vectors, metadata, mockEnv, mockLogger);

    expect(mockVectorize.insert).toHaveBeenCalledTimes(1);
    const insertCall = mockVectorize.insert.mock.calls[0][0];
    expect(insertCall).toHaveLength(2);
    expect(insertCall[0]).toEqual({
      id: "msg1",
      values: [0.1, 0.2],
      metadata: metadata[0],
    });
    expect(insertCall[1]).toEqual({
      id: "msg2",
      values: [0.3, 0.4],
      metadata: metadata[1],
    });
  });

  test("should throw error when vector and metadata counts mismatch", async () => {
    const vectors = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const metadata = [
      {
        messageId: "msg1",
        chatId: "chat1",
        timestamp: "2024-01-01T00:00:00Z",
        text: "text1",
      },
    ];

    await expect(
      insertEmbeddings(vectors, metadata, mockEnv, mockLogger)
    ).rejects.toThrow(
      "Number of vectors must match number of metadata objects."
    );
  });

  test("should throw error when VECTORIZE_INDEX binding is missing", async () => {
    const vectors = [[0.1, 0.2]];
    const metadata = [
      {
        messageId: "msg1",
        chatId: "chat1",
        timestamp: "2024-01-01T00:00:00Z",
        text: "text1",
      },
    ];
    const envWithoutVectorize = { VECTORIZE_INDEX: undefined };

    await expect(
      insertEmbeddings(vectors, metadata, envWithoutVectorize, mockLogger)
    ).rejects.toThrow("Vectorize service not available.");
  });

  test("should return early when vectors array is empty", async () => {
    await insertEmbeddings([], [], mockEnv, mockLogger);

    expect(mockVectorize.insert).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "No data to insert into Vectorize."
    );
  });

  test("should throw error when Vectorize insert fails", async () => {
    const vectors = [[0.1, 0.2]];
    const metadata = [
      {
        messageId: "msg1",
        chatId: "chat1",
        timestamp: "2024-01-01T00:00:00Z",
        text: "text1",
      },
    ];
    mockVectorize.insert.mockRejectedValueOnce(
      new Error("Vectorize Insert Failed")
    );

    await expect(
      insertEmbeddings(vectors, metadata, mockEnv, mockLogger)
    ).rejects.toThrow(/Failed to insert embeddings: Vectorize Insert Failed/);
  });
});

describe("queryEmbeddings", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockAI: { run: ReturnType<typeof mock> };
  let mockVectorize: {
    insert: ReturnType<typeof mock>;
    query: ReturnType<typeof mock>;
    describeIndex: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mock.restore();
    mockLogger = createMockLogger();
    mockAI = { run: mock() };
    mockVectorize = {
      insert: mock(),
      query: mock(),
      describeIndex: mock().mockResolvedValue({}),
    };
    mockEnv = { AI: mockAI, VECTORIZE_INDEX: mockVectorize };
  });

  test("should query embeddings and return matches", async () => {
    const queryEmbedding = [[0.5, 0.6, 0.7]];
    mockAI.run.mockResolvedValueOnce({ data: queryEmbedding });
    const mockMatches: VectorizeMatches = {
      matches: [
        { id: "msg1", score: 0.95, metadata: { text: "matching text" } },
        { id: "msg2", score: 0.88, metadata: { text: "another match" } },
      ],
    };
    mockVectorize.query.mockResolvedValueOnce(mockMatches);

    const result = await queryEmbeddings(
      "search query",
      mockEnv,
      mockLogger,
      5
    );

    expect(result).toEqual(mockMatches);
    expect(mockAI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: "search query",
    });
    expect(mockVectorize.query).toHaveBeenCalledWith(queryEmbedding[0], {
      topK: 5,
      returnMetadata: true,
    });
  });

  test("should use default topK of 3 when not specified", async () => {
    const queryEmbedding = [[0.5, 0.6]];
    mockAI.run.mockResolvedValueOnce({ data: queryEmbedding });
    mockVectorize.query.mockResolvedValueOnce({ matches: [] });

    await queryEmbeddings("search query", mockEnv, mockLogger);

    expect(mockVectorize.query).toHaveBeenCalledWith(queryEmbedding[0], {
      topK: 3,
      returnMetadata: true,
    });
  });

  test("should throw error when AI binding is missing", async () => {
    const envWithoutAI = { AI: undefined, VECTORIZE_INDEX: mockVectorize };

    await expect(
      queryEmbeddings("search", envWithoutAI, mockLogger)
    ).rejects.toThrow("AI service not available for query embedding.");
  });

  test("should throw error when Vectorize binding is missing", async () => {
    const envWithoutVectorize = { AI: mockAI, VECTORIZE_INDEX: undefined };

    await expect(
      queryEmbeddings("search", envWithoutVectorize, mockLogger)
    ).rejects.toThrow("Vectorize service not available.");
  });

  test("should throw error when query embedding generation fails", async () => {
    mockAI.run.mockRejectedValueOnce(new Error("Embedding generation failed"));

    await expect(
      queryEmbeddings("search", mockEnv, mockLogger)
    ).rejects.toThrow(
      /Failed to query embeddings: Failed to generate embeddings: Embedding generation failed/
    );
  });

  test("should throw error when Vectorize query fails", async () => {
    mockAI.run.mockResolvedValueOnce({ data: [[0.5]] });
    mockVectorize.query.mockRejectedValueOnce(new Error("Query failed"));

    await expect(
      queryEmbeddings("search", mockEnv, mockLogger)
    ).rejects.toThrow(/Failed to query embeddings: Query failed/);
  });
});
