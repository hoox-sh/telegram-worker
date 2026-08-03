/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { toError } from "@hoox-sh/hoox-shared/errors";
import type { Logger } from "@hoox-sh/hoox-shared/middleware";
import type { VectorizeVector } from "@cloudflare/workers-types";

// Define the structure for metadata stored with embeddings
export interface TelegramMessageMetadata {
  messageId: string; // Use Telegram's message ID
  chatId: string;
  senderId?: string; // Optional, might not always be available/needed
  timestamp: string; // ISO 8601 format
  text: string;
}

export interface VectorizeMatches {
  matches: Array<{
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
}

/** Shape of the Workers AI bge-base-en embedding response we consume. */
interface EmbeddingResponse {
  data?: number[][];
  shape?: number[];
}

/**
 * Generates embeddings for the given text using Cloudflare Workers AI.
 */
export async function generateEmbeddings(
  text: string | string[],
  env: Env,
  logger: Logger
): Promise<number[][]> {
  if (!env.AI) {
    logger.error("AI binding is not configured in the environment.");
    throw new Error("AI service not available.");
  }

  try {
    logger.info(`Generating embeddings for input text...`);
    const response: EmbeddingResponse = (await env.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      {
        text,
      }
    )) as EmbeddingResponse;

    if (!response || !response.data || !Array.isArray(response.data)) {
      logger.error("Invalid response structure from AI embedding model", {
        response: JSON.stringify(response),
      });
      throw new Error("Failed to parse embeddings from AI response.");
    }

    logger.info(`Successfully generated ${response.data.length} embedding(s).`);
    return response.data;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown AI error");
    logger.error("Error generating embeddings", { error: errorMsg });
    throw new Error(`Failed to generate embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
}

/**
 * Inserts embeddings and associated metadata into the Vectorize index.
 */
export async function insertEmbeddings(
  vectors: number[][],
  metadata: TelegramMessageMetadata[],
  env: Env,
  logger: Logger
): Promise<void> {
  if (vectors.length !== metadata.length) {
    throw new Error("Number of vectors must match number of metadata objects.");
  }

  if (!env.VECTORIZE_INDEX) {
    logger.error(
      "VECTORIZE_INDEX binding is not configured in the environment."
    );
    throw new Error("Vectorize service not available.");
  }

  // Prepare data for insertion
  const dataToInsert = vectors.map((vector, index) => ({
    id: metadata[index].messageId, // Use messageId as the vector ID
    values: vector,
    metadata: metadata[index] as unknown as Record<string, unknown>, // Store the whole metadata object
  }));

  if (dataToInsert.length === 0) {
    logger.info("No data to insert into Vectorize.");
    return;
  }

  try {
    logger.info(
      `Inserting ${dataToInsert.length} vector(s) into Vectorize index...`
    );
    const insertResult = await env.VECTORIZE_INDEX.insert(
      dataToInsert as VectorizeVector[]
    );
    logger.info("Vectorize insertion successful", { result: insertResult });
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown Vectorize error");
    logger.error("Error inserting embeddings into Vectorize", {
      error: errorMsg,
    });
    throw new Error(`Failed to insert embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
}

/**
 * Queries the Vectorize index for vectors similar to the query text.
 */
export async function queryEmbeddings(
  queryText: string,
  env: Env,
  logger: Logger,
  topK: number = 3
): Promise<VectorizeMatches> {
  if (!env.VECTORIZE_INDEX) {
    logger.error("VECTORIZE_INDEX binding is not configured.");
    throw new Error("Vectorize service not available.");
  }
  if (!env.AI) {
    logger.error("AI binding is not configured.");
    throw new Error("AI service not available for query embedding.");
  }

  try {
    // 1. Generate embedding for the query text
    logger.info(`Generating embedding for query: "${queryText}"...`);
    const queryEmbedding = (
      await generateEmbeddings(queryText, env, logger)
    )[0]; // Expecting a single vector back

    if (!queryEmbedding) {
      throw new Error("Failed to generate embedding for query text.");
    }

    // 2. Query Vectorize
    logger.info(`Querying Vectorize index with topK=${topK}...`);
    const results = await env.VECTORIZE_INDEX.query(queryEmbedding, {
      topK,
      returnMetadata: true,
    });
    logger.info(`Vectorize query found ${results.matches.length} match(es).`);

    return results;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown query error");
    logger.error("Error querying embeddings", { error: errorMsg });
    throw new Error(`Failed to query embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
}
