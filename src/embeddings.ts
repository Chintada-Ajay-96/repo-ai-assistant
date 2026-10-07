import OpenAI from "openai";
import { type CodeChunk } from "./codeChunks.js";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_BATCH_SIZE = 20;

export interface EmbeddedCodeChunk {
  chunk: CodeChunk;
  embedding: number[];
}

export interface EmbeddingClient {
  embeddings: {
    create(params: {
      model: string;
      input: string[];
    }): Promise<{
      data: Array<{
        embedding: number[];
        index?: number;
      }>;
    }>;
  };
}

export interface GenerateEmbeddingsOptions {
  apiKey?: string;
  model?: string;
  batchSize?: number;
  client?: EmbeddingClient;
}

/**
 * Creates a structured text representation for embedding a CodeChunk.
 * Combines metadata (Language, File, Symbol, Type, Parent) and the actual code.
 * Preserves the original chunk.code unmodified.
 */
export function formatChunkForEmbedding(chunk: CodeChunk): string {
  const parts: string[] = [
    `Language: ${chunk.language}`,
    `File: ${chunk.file}`,
    `Symbol: ${chunk.symbol}`,
    `Type: ${chunk.type}`,
  ];

  if (chunk.parent) {
    parts.push(`Parent: ${chunk.parent}`);
  }

  parts.push("", "Code:", chunk.code);

  return parts.join("\n");
}

/**
 * Splits an array into batches of a given size.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`Batch size must be greater than 0, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Generates embedding vectors for an array of CodeChunks.
 * Batches requests to the embedding API and attaches vectors to each chunk.
 */
export async function generateEmbeddings(
  chunks: CodeChunk[],
  options?: GenerateEmbeddingsOptions
): Promise<EmbeddedCodeChunk[]> {
  // Empty chunks list: return empty result without requiring API key
  if (chunks.length === 0) {
    return [];
  }

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize <= 0) {
    throw new Error(`Batch size must be greater than 0, received ${batchSize}`);
  }

  const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;

  let client = options?.client;
  if (!client) {
    const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "Missing OpenAI API key. Please set the OPENAI_API_KEY environment variable."
      );
    }
    client = new OpenAI({ apiKey });
  }

  const batches = chunkArray(chunks, batchSize);
  const embeddedChunks: EmbeddedCodeChunk[] = [];

  for (const batch of batches) {
    const inputs = batch.map(formatChunkForEmbedding);

    let response;
    try {
      response = await client.embeddings.create({
        model,
        input: inputs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate embeddings from provider: ${message}`);
    }

    if (!response || !Array.isArray(response.data)) {
      throw new Error("Invalid embedding response: missing or malformed 'data' array.");
    }

    if (response.data.length !== batch.length) {
      throw new Error(
        `Invalid embedding response: expected ${batch.length} embeddings, received ${response.data.length}.`
      );
    }

    // Sort by index if provided by the API to ensure 100% order alignment
    const sortedData = [...response.data].sort((a, b) => {
      if (a.index !== undefined && b.index !== undefined) {
        return a.index - b.index;
      }
      return 0;
    });

    for (let i = 0; i < batch.length; i++) {
      const chunk = batch[i]!;
      const item = sortedData[i];

      if (!item || !Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new Error(
          `Invalid embedding vector for symbol '${chunk.symbol}' in file '${chunk.file}'.`
        );
      }

      embeddedChunks.push({
        chunk,
        embedding: item.embedding,
      });
    }
  }

  return embeddedChunks;
}
