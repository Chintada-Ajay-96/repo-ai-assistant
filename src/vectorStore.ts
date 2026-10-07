import * as fs from "node:fs";
import * as path from "node:path";
import { type CodeChunk, buildRepoChunks } from "./codeChunks.js";
import {
  type EmbeddedCodeChunk,
  generateEmbeddings,
  generateQueryEmbedding,
  type GenerateEmbeddingsOptions,
} from "./embeddings.js";

export const DEFAULT_VECTOR_STORE_PATH = ".data/vector-store.json";

export interface VectorRecord {
  id: string;
  chunk: CodeChunk;
  embedding: number[];
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
}

export interface SerializedVectorStore {
  version: number;
  createdAt: string;
  records: VectorRecord[];
}

/**
 * Computes cosine similarity between two numeric vectors.
 * Formula: dot(A, B) / (||A|| * ||B||)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: vector A has length ${a.length}, but vector B has length ${b.length}.`
    );
  }

  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Generates a stable unique identifier for a CodeChunk.
 */
export function getChunkId(chunk: CodeChunk): string {
  const parentPart = chunk.parent ? `:${chunk.parent}` : "";
  return `${chunk.file}:${chunk.symbol}:${chunk.type}:${chunk.startLine}-${chunk.endLine}${parentPart}`;
}

/**
 * In-memory local vector store with file persistence and cosine-similarity search.
 */
export class VectorStore {
  private records: Map<string, VectorRecord> = new Map();

  /**
   * Adds or upserts an embedded code chunk into the vector store.
   */
  add(record: VectorRecord | EmbeddedCodeChunk): void {
    const id = "id" in record && record.id ? record.id : getChunkId(record.chunk);
    if (!Array.isArray(record.embedding) || record.embedding.length === 0) {
      throw new Error(`Cannot add record with invalid embedding vector for symbol '${record.chunk.symbol}'.`);
    }
    this.records.set(id, {
      id,
      chunk: record.chunk,
      embedding: record.embedding,
    });
  }

  /**
   * Adds or upserts multiple embedded chunks.
   */
  addMany(records: (VectorRecord | EmbeddedCodeChunk)[]): void {
    for (const record of records) {
      this.add(record);
    }
  }

  /**
   * Returns all stored vector records.
   */
  getRecords(): VectorRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Returns a record by ID if it exists.
   */
  get(id: string): VectorRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Number of stored records.
   */
  size(): number {
    return this.records.size;
  }

  /**
   * Clears all stored records.
   */
  clear(): void {
    this.records.clear();
  }

  /**
   * Searches the store for the top-K chunks most similar to the query vector.
   */
  search(queryEmbedding: number[], topK = 5): SearchResult[] {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error("Query embedding must be a non-empty array of numbers.");
    }

    if (topK <= 0 || !Number.isInteger(topK)) {
      throw new Error(`topK must be a positive integer, got ${topK}.`);
    }

    const allRecords = this.getRecords();
    if (allRecords.length === 0) {
      return [];
    }

    const scored: SearchResult[] = [];

    for (const record of allRecords) {
      const score = cosineSimilarity(queryEmbedding, record.embedding);
      scored.push({
        chunk: record.chunk,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }

  /**
   * Persists the vector store to a JSON file on disk.
   */
  async saveToFile(filePath = DEFAULT_VECTOR_STORE_PATH): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const data: SerializedVectorStore = {
      version: 1,
      createdAt: new Date().toISOString(),
      records: this.getRecords(),
    };

    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Loads the vector store from a JSON file on disk.
   */
  async loadFromFile(filePath = DEFAULT_VECTOR_STORE_PATH): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Vector store file not found at: ${filePath}`);
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read vector store file at '${filePath}': ${msg}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Malformed vector store JSON in file: ${filePath}`);
    }

    if (!parsed || typeof parsed !== "object" || !("records" in parsed) || !Array.isArray((parsed as any).records)) {
      throw new Error(`Invalid vector store schema in file: ${filePath}. Missing 'records' array.`);
    }

    const records = (parsed as SerializedVectorStore).records;
    this.clear();

    for (const item of records) {
      if (!item || !item.chunk || !Array.isArray(item.embedding)) {
        throw new Error(`Invalid record in vector store file: ${filePath}`);
      }
      this.add(item);
    }
  }
}

/**
 * Indexes a repository: discovers source files, extracts code chunks,
 * generates embeddings, and saves the vector store to disk.
 */
export async function indexRepository(
  rootDir: string,
  storePath = DEFAULT_VECTOR_STORE_PATH,
  options?: GenerateEmbeddingsOptions
): Promise<VectorStore> {
  const chunks = await buildRepoChunks(rootDir);
  const embeddedChunks = await generateEmbeddings(chunks, options);

  const store = new VectorStore();
  store.addMany(embeddedChunks);
  await store.saveToFile(storePath);

  return store;
}

/**
 * Searches the indexed repository using natural language semantic search.
 */
export async function searchCode(
  query: string,
  topK = 5,
  storePath = DEFAULT_VECTOR_STORE_PATH,
  options?: GenerateEmbeddingsOptions
): Promise<SearchResult[]> {
  const store = new VectorStore();
  await store.loadFromFile(storePath);

  const queryEmbedding = await generateQueryEmbedding(query, options);
  return store.search(queryEmbedding, topK);
}
