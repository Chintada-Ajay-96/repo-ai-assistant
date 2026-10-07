import * as fs from "node:fs";
import { type CodeChunk } from "./codeChunks.js";
import {
  generateQueryEmbedding,
  type GenerateEmbeddingsOptions,
  type EmbeddingClient,
} from "./embeddings.js";
import {
  VectorStore,
  getChunkId,
  DEFAULT_VECTOR_STORE_PATH,
  type SearchResult,
} from "./vectorStore.js";

export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_CHARACTERS = 12000;
export const CONTEXT_SEPARATOR = "--------------------------------------------------";

/**
 * A retrieved code chunk paired with its semantic similarity score.
 */
export interface RetrievedChunk {
  chunk: CodeChunk;
  score: number;
}

/**
 * Result of a retrieval operation for a given query.
 */
export interface RetrievalResult {
  query: string;
  results: RetrievedChunk[];
}

/**
 * Output of context preparation for an LLM prompt.
 */
export interface ContextResult {
  context: string;
  includedChunks: number;
  totalCharacters: number;
}

/**
 * Options for configuring code retrieval.
 */
export interface RetrieveOptions {
  topK?: number;
  storePath?: string;
  store?: VectorStore;
  embeddingOptions?: GenerateEmbeddingsOptions;
  client?: EmbeddingClient;
  apiKey?: string;
  model?: string;
}

/**
 * Options for configuring context construction.
 */
export interface BuildContextOptions {
  maxCharacters?: number;
}

/**
 * Formats a similarity score cleanly for context display.
 */
export function formatScore(score: number): string {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return "0";
  }
  const rounded = Number(score.toFixed(4));
  return rounded.toString();
}

/**
 * Formats a single retrieved chunk into a structured text representation.
 */
export function formatSingleChunkContext(item: RetrievedChunk): string {
  const lines: string[] = [
    `File: ${item.chunk.file}`,
    `Symbol: ${item.chunk.symbol}`,
    `Type: ${item.chunk.type}`,
  ];

  if (item.chunk.parent) {
    lines.push(`Parent: ${item.chunk.parent}`);
  }

  lines.push(`Lines: ${item.chunk.startLine}-${item.chunk.endLine}`);
  lines.push(`Similarity: ${formatScore(item.score)}`);
  lines.push("");
  lines.push(item.chunk.code);

  return lines.join("\n");
}

/**
 * Builds structured text context from retrieved search results.
 * Respects character limits without truncating individual code chunks,
 * removes duplicate chunks, and preserves result ranking order.
 */
export function buildContext(
  input: RetrievedChunk[] | RetrievalResult,
  options?: BuildContextOptions
): ContextResult {
  if (!input) {
    throw new Error("Results must be provided to buildContext.");
  }

  const results = Array.isArray(input) ? input : input.results;
  if (!Array.isArray(results)) {
    throw new Error("Results must be an array or a RetrievalResult object containing a results array.");
  }

  const maxCharacters = options?.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (typeof maxCharacters !== "number" || maxCharacters <= 0 || !Number.isFinite(maxCharacters)) {
    throw new Error(`maxCharacters must be a positive number, got ${maxCharacters}.`);
  }

  if (results.length === 0) {
    return {
      context: "",
      includedChunks: 0,
      totalCharacters: 0,
    };
  }

  const seenIds = new Set<string>();
  const includedBlocks: string[] = [];

  for (const item of results) {
    if (!item || !item.chunk) {
      continue;
    }

    // Stable chunk identity deduplication
    const id = getChunkId(item.chunk);
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const block = formatSingleChunkContext(item);

    // Test candidate context with separator delimiters
    const candidateBlocks = [...includedBlocks, block];
    const candidateContext = `${CONTEXT_SEPARATOR}\n${candidateBlocks.join(`\n${CONTEXT_SEPARATOR}\n`)}\n${CONTEXT_SEPARATOR}`;

    if (candidateContext.length <= maxCharacters) {
      includedBlocks.push(block);
    } else {
      // Stop adding results when adding this chunk would exceed the limit.
      // Never cut a code chunk in the middle.
      break;
    }
  }

  const finalContext = includedBlocks.length === 0
    ? ""
    : `${CONTEXT_SEPARATOR}\n${includedBlocks.join(`\n${CONTEXT_SEPARATOR}\n`)}\n${CONTEXT_SEPARATOR}`;

  return {
    context: finalContext,
    includedChunks: includedBlocks.length,
    totalCharacters: finalContext.length,
  };
}

/**
 * Retrieves relevant code chunks for a natural-language query by generating
 * a query embedding and searching the vector store.
 */
export async function retrieveRelevantCode(
  query: string,
  options?: RetrieveOptions
): Promise<RetrievalResult> {
  if (!query || typeof query !== "string" || query.trim() === "") {
    throw new Error("Query cannot be empty.");
  }

  const topK = options?.topK ?? DEFAULT_TOP_K;
  if (typeof topK !== "number" || topK <= 0 || !Number.isInteger(topK)) {
    throw new Error(`topK must be a positive integer, got ${topK}.`);
  }

  let store = options?.store;
  if (!store) {
    const storePath = options?.storePath ?? DEFAULT_VECTOR_STORE_PATH;
    if (!fs.existsSync(storePath)) {
      throw new Error(`Vector store file not found at: ${storePath}. Please build the repository index first.`);
    }
    store = new VectorStore();
    await store.loadFromFile(storePath);
  }

  // Reuse existing Phase 2B embedding options and abstraction
  const embeddingOpts: GenerateEmbeddingsOptions = {
    ...options?.embeddingOptions,
  };
  const client = options?.client ?? options?.embeddingOptions?.client;
  if (client !== undefined) {
    embeddingOpts.client = client;
  }
  const apiKey = options?.apiKey ?? options?.embeddingOptions?.apiKey;
  if (apiKey !== undefined) {
    embeddingOpts.apiKey = apiKey;
  }
  const model = options?.model ?? options?.embeddingOptions?.model;
  if (model !== undefined) {
    embeddingOpts.model = model;
  }

  const queryEmbedding = await generateQueryEmbedding(query, embeddingOpts);
  const searchResults: SearchResult[] = store.search(queryEmbedding, topK);

  return {
    query: query.trim(),
    results: searchResults,
  };
}
