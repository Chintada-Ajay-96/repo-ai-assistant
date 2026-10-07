import { GoogleGenAI } from "@google/genai";
import { type CodeChunk } from "./codeChunks.js";

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // Ignore if .env does not exist
}

/**
 * Official default Gemini embedding model.
 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-004";

/**
 * Default batch size for grouping chunks into embedding requests.
 */
export const DEFAULT_BATCH_SIZE = 20;

/**
 * A CodeChunk paired with its embedding vector.
 */
export interface EmbeddedCodeChunk {
  chunk: CodeChunk;
  embedding: number[];
}

/**
 * Provider-agnostic interface for generating text embeddings.
 * Can be mocked in tests or implemented for different embedding providers.
 */
export interface EmbeddingClient {
  embedTexts(inputs: string[]): Promise<number[][]>;
}

/**
 * Minimal structural interface for the @google/genai SDK models client.
 * Allows dependency injection of mock SDK clients in unit tests.
 */
export interface GeminiEmbeddingSdkClient {
  models: {
    embedContent(params: {
      model: string;
      contents: string[];
    }): Promise<{
      embeddings?: Array<{
        values?: number[] | undefined;
      }> | undefined;
    }>;
  };
}

/**
 * Options for configuring GeminiEmbeddingClient.
 */
export interface GeminiEmbeddingClientOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  sdkClient?: GeminiEmbeddingSdkClient | undefined;
}

/**
 * Concrete Gemini implementation of the EmbeddingClient interface using @google/genai.
 */
export class GeminiEmbeddingClient implements EmbeddingClient {
  private readonly model: string;
  private readonly client: GeminiEmbeddingSdkClient;

  constructor(options?: GeminiEmbeddingClientOptions) {
    this.model = options?.model && options.model.trim() !== ""
      ? options.model.trim()
      : DEFAULT_EMBEDDING_MODEL;

    if (options?.sdkClient) {
      this.client = options.sdkClient;
    } else {
      const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey.trim() === "") {
        throw new Error(
          "Missing Gemini API key. Please set the GEMINI_API_KEY environment variable."
        );
      }
      this.client = new GoogleGenAI({ apiKey: apiKey.trim() });
    }
  }

  /**
   * Returns the configured Gemini embedding model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Embeds an array of text inputs using Gemini's embedContent API.
   */
  async embedTexts(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    let response;
    try {
      response = await this.client.models.embedContent({
        model: this.model,
        contents: inputs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate embeddings from provider: ${message}`);
    }

    if (!response || !Array.isArray(response.embeddings)) {
      throw new Error("Invalid embedding response: missing or malformed 'embeddings' array.");
    }

    if (response.embeddings.length !== inputs.length) {
      throw new Error(
        `Invalid embedding response: expected ${inputs.length} embeddings, received ${response.embeddings.length}.`
      );
    }

    return response.embeddings.map((item, index) => {
      if (!item || !Array.isArray(item.values) || item.values.length === 0) {
        throw new Error(`Invalid embedding vector at index ${index}.`);
      }
      return item.values;
    });
  }
}

/**
 * Factory helper function to instantiate a GeminiEmbeddingClient.
 */
export function createGeminiEmbeddingClient(
  options?: GeminiEmbeddingClientOptions
): GeminiEmbeddingClient {
  return new GeminiEmbeddingClient(options);
}

/**
 * Options for generating embeddings.
 */
export interface GenerateEmbeddingsOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  batchSize?: number | undefined;
  client?: EmbeddingClient | undefined;
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
 * Batches requests to the embedding client and attaches vectors to each chunk.
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
    client = new GeminiEmbeddingClient({
      apiKey: options?.apiKey,
      model,
    });
  }

  const batches = chunkArray(chunks, batchSize);
  const embeddedChunks: EmbeddedCodeChunk[] = [];

  for (const batch of batches) {
    const inputs = batch.map(formatChunkForEmbedding);

    let vectors: number[][];
    try {
      vectors = await client.embedTexts(inputs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.startsWith("Failed to generate embeddings from provider") ||
        message.startsWith("Invalid embedding")
      ) {
        throw err;
      }
      throw new Error(`Failed to generate embeddings from provider: ${message}`);
    }

    if (!Array.isArray(vectors)) {
      throw new Error("Invalid embedding response: expected array of embedding vectors.");
    }

    if (vectors.length !== batch.length) {
      throw new Error(
        `Invalid embedding response: expected ${batch.length} embeddings, received ${vectors.length}.`
      );
    }

    for (let i = 0; i < batch.length; i++) {
      const chunk = batch[i]!;
      const vector = vectors[i];

      if (!vector || !Array.isArray(vector) || vector.length === 0) {
        throw new Error(
          `Invalid embedding vector for symbol '${chunk.symbol}' in file '${chunk.file}'.`
        );
      }

      embeddedChunks.push({
        chunk,
        embedding: vector,
      });
    }
  }

  return embeddedChunks;
}

/**
 * Generates an embedding vector for a single query string.
 * Uses the same embedding client and model as repository indexing.
 */
export async function generateQueryEmbedding(
  query: string,
  options?: GenerateEmbeddingsOptions
): Promise<number[]> {
  if (!query || query.trim() === "") {
    throw new Error("Query cannot be empty.");
  }

  const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;

  let client = options?.client;
  if (!client) {
    client = new GeminiEmbeddingClient({
      apiKey: options?.apiKey,
      model,
    });
  }

  let vectors: number[][];
  try {
    vectors = await client.embedTexts([query.trim()]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.startsWith("Failed to generate embeddings from provider") ||
      message.startsWith("Invalid embedding")
    ) {
      throw err;
    }
    throw new Error(`Failed to generate query embedding from provider: ${message}`);
  }

  const vector = vectors?.[0];
  if (!vector || !Array.isArray(vector) || vector.length === 0) {
    throw new Error("Invalid query embedding response from provider.");
  }

  return vector;
}
