import * as fs from "node:fs";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { type CodeChunk, buildRepoChunks } from "./codeChunks.js";
import {
  type EmbeddedCodeChunk,
  generateEmbeddings,
  generateQueryEmbedding,
  type GenerateEmbeddingsOptions,
} from "./embeddings.js";

export const DEFAULT_VECTOR_STORE_PATH = ".data/vector-store.json";
export const DEFAULT_LANCEDB_DIR = ".data/lancedb";
export const DEFAULT_LANCEDB_TABLE = "code_chunks";
export const DEFAULT_VECTOR_BACKEND = "lancedb";

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
 * Shared abstraction for vector stores (LanceDB, in-memory, or custom).
 */
export interface IVectorStore {
  add(record: VectorRecord | EmbeddedCodeChunk): Promise<void> | void;
  addMany(records: (VectorRecord | EmbeddedCodeChunk)[]): Promise<void> | void;
  get(id: string): Promise<VectorRecord | undefined> | VectorRecord | undefined;
  getRecords(): Promise<VectorRecord[]> | VectorRecord[];
  size(): Promise<number> | number;
  clear(): Promise<void> | void;
  search(queryEmbedding: number[], topK?: number): Promise<SearchResult[]> | SearchResult[];
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
 * Retained in full to provide deterministic, zero-dependency testing and fallback.
 */
export class VectorStore implements IVectorStore {
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
 * Options for configuring LanceDbVectorStore.
 */
export interface LanceDbStoreOptions {
  dbDir?: string | undefined;
  tableName?: string | undefined;
  expectedDimension?: number | undefined;
}

/**
 * Internal schema structure for LanceDB records.
 */
export interface LanceDbRecord {
  id: string;
  vector: number[];
  file: string;
  language: string;
  symbol: string;
  chunkType: string;
  startLine: number;
  endLine: number;
  parent: string;
  code: string;
  chunkJson: string;
  [key: string]: unknown;
}

/**
 * Dedicated local vector database implementation powered by LanceDB.
 * Supports persistent on-disk storage, native cosine distance search,
 * strict dimension validation, and metadata filtering.
 */
export class LanceDbVectorStore implements IVectorStore {
  private readonly dbDir: string;
  private readonly tableName: string;
  private expectedDimension?: number | undefined;
  private records: Map<string, VectorRecord> = new Map();
  private dbInstance: lancedb.Connection | null = null;
  private tableInstance: lancedb.Table | null = null;

  constructor(options?: LanceDbStoreOptions) {
    this.dbDir = options?.dbDir ?? DEFAULT_LANCEDB_DIR;
    this.tableName = options?.tableName ?? DEFAULT_LANCEDB_TABLE;
    this.expectedDimension = options?.expectedDimension;
  }

  getDbDir(): string {
    return this.dbDir;
  }

  getTableName(): string {
    return this.tableName;
  }

  getExpectedDimension(): number | undefined {
    return this.expectedDimension;
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.dbInstance) {
      await fs.promises.mkdir(this.dbDir, { recursive: true });
      this.dbInstance = await lancedb.connect(this.dbDir);
    }
    return this.dbInstance;
  }

  private async getTable(): Promise<lancedb.Table | null> {
    if (this.tableInstance) {
      return this.tableInstance;
    }
    const db = await this.getDb();
    const tables = await db.tableNames();
    if (tables.includes(this.tableName)) {
      this.tableInstance = await db.openTable(this.tableName);
      if (this.expectedDimension === undefined) {
        // Infer dimension from the first record in the table
        try {
          const sample = await this.tableInstance.query().limit(1).toArray();
          if (sample.length > 0 && Array.isArray(sample[0]?.vector)) {
            this.expectedDimension = sample[0].vector.length;
          }
        } catch {
          // Ignore if table is empty
        }
      }
      return this.tableInstance;
    }
    return null;
  }

  /**
   * Adds or upserts an embedded code chunk with dimension validation.
   */
  add(record: VectorRecord | EmbeddedCodeChunk): void {
    const id = "id" in record && record.id ? record.id : getChunkId(record.chunk);
    if (!Array.isArray(record.embedding) || record.embedding.length === 0) {
      throw new Error(`Cannot add record with invalid embedding vector for symbol '${record.chunk.symbol}'.`);
    }
    for (const val of record.embedding) {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new Error(
          `Embedding vector for symbol '${record.chunk.symbol}' contains non-finite numbers.`
        );
      }
    }

    if (this.expectedDimension !== undefined && record.embedding.length !== this.expectedDimension) {
      throw new Error(
        `Vector dimension mismatch: expected dimension ${this.expectedDimension}, but received ${record.embedding.length} for symbol '${record.chunk.symbol}'.`
      );
    }

    if (this.expectedDimension === undefined) {
      this.expectedDimension = record.embedding.length;
    }

    this.records.set(id, {
      id,
      chunk: record.chunk,
      embedding: record.embedding,
    });
  }

  /**
   * Adds multiple records.
   */
  addMany(records: (VectorRecord | EmbeddedCodeChunk)[]): void {
    for (const record of records) {
      this.add(record);
    }
  }

  /**
   * Returns all vector records currently in memory.
   */
  getRecords(): VectorRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Retrieves a record by ID from memory or the persistent LanceDB table.
   */
  async get(id: string): Promise<VectorRecord | undefined> {
    const inMemory = this.records.get(id);
    if (inMemory) {
      return inMemory;
    }

    const table = await this.getTable();
    if (!table) {
      return undefined;
    }

    const escapedId = id.replace(/'/g, "''");
    try {
      const rows = await table.query().where(`id = '${escapedId}'`).limit(1).toArray();
      if (rows.length === 0 || !rows[0]) {
        return undefined;
      }
      const r = rows[0];
      let chunk: CodeChunk;
      if (r.chunkJson) {
        chunk = JSON.parse(r.chunkJson);
      } else {
        chunk = {
          file: r.file,
          language: r.language,
          symbol: r.symbol,
          type: r.chunkType,
          startLine: r.startLine,
          endLine: r.endLine,
          code: r.code,
          ...(r.parent ? { parent: r.parent } : {}),
        };
      }
      return {
        id: r.id,
        chunk,
        embedding: Array.from(r.vector),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the total number of records in the store.
   */
  async size(): Promise<number> {
    const table = await this.getTable();
    if (table) {
      return await table.countRows();
    }
    return this.records.size;
  }

  /**
   * Drops the LanceDB table and clears in-memory buffers.
   */
  async clear(): Promise<void> {
    this.records.clear();
    this.expectedDimension = undefined;
    const db = await this.getDb();
    const tables = await db.tableNames();
    if (tables.includes(this.tableName)) {
      await db.dropTable(this.tableName);
      this.tableInstance = null;
    }
  }

  /**
   * Persists all buffered records to the LanceDB table on disk.
   * Uses overwrite mode to guarantee re-indexing completely replaces stale chunks.
   * If records are empty, drops the table so no stale dataset remains.
   */
  async save(): Promise<void> {
    if (this.records.size === 0) {
      await this.clear();
      return;
    }
    const db = await this.getDb();
    const rows: LanceDbRecord[] = Array.from(this.records.values()).map((r) => ({
      id: r.id,
      vector: r.embedding,
      file: r.chunk.file,
      language: r.chunk.language,
      symbol: r.chunk.symbol,
      chunkType: r.chunk.type,
      startLine: r.chunk.startLine,
      endLine: r.chunk.endLine,
      parent: r.chunk.parent ?? "",
      code: r.chunk.code,
      chunkJson: JSON.stringify(r.chunk),
    }));

    if (this.expectedDimension === undefined && rows.length > 0 && rows[0]?.vector) {
      this.expectedDimension = rows[0].vector.length;
    }

    this.tableInstance = await db.createTable(this.tableName, rows, { mode: "overwrite" });
  }

  /**
   * Reopens an existing LanceDB table from disk and syncs records into memory.
   */
  async load(): Promise<void> {
    const table = await this.getTable();
    if (!table) {
      throw new Error(`LanceDB table '${this.tableName}' not found in database directory '${this.dbDir}'.`);
    }

    try {
      const rows = await table.query().toArray();
      this.records.clear();
      for (const r of rows) {
        let chunk: CodeChunk;
        if (r.chunkJson) {
          try {
            chunk = JSON.parse(r.chunkJson);
          } catch {
            chunk = {
              file: r.file,
              language: r.language,
              symbol: r.symbol,
              type: r.chunkType,
              startLine: r.startLine,
              endLine: r.endLine,
              code: r.code,
              ...(r.parent ? { parent: r.parent } : {}),
            };
          }
        } else {
          chunk = {
            file: r.file,
            language: r.language,
            symbol: r.symbol,
            type: r.chunkType,
            startLine: r.startLine,
            endLine: r.endLine,
            code: r.code,
            ...(r.parent ? { parent: r.parent } : {}),
          };
        }
        this.records.set(r.id, {
          id: r.id,
          chunk,
          embedding: Array.from(r.vector),
        });
      }
    } catch {
      // Table instance remains available for search
    }
  }

  /**
   * Performs semantic vector search using cosine similarity ranking.
   * Accurately converts LanceDB cosine distance (0 to 2) into cosine similarity (-1 to 1).
   */
  async search(queryEmbedding: number[], topK = 5): Promise<SearchResult[]> {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error("Query embedding must be a non-empty array of numbers.");
    }
    for (const val of queryEmbedding) {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new Error("Query embedding contains non-finite numbers.");
      }
    }
    if (topK <= 0 || !Number.isInteger(topK)) {
      throw new Error(`topK must be a positive integer, got ${topK}.`);
    }

    const table = await this.getTable();
    if (table) {
      const rowCount = await table.countRows();
      if (rowCount === 0) {
        return [];
      }

      if (this.expectedDimension !== undefined && queryEmbedding.length !== this.expectedDimension) {
        throw new Error(
          `Vector dimension mismatch: query vector has dimension ${queryEmbedding.length}, but table expects dimension ${this.expectedDimension}.`
        );
      }

      let rawResults: any[];
      try {
        rawResults = await table
          .vectorSearch(queryEmbedding)
          .distanceType("cosine")
          .limit(topK)
          .toArray();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("dimension") || msg.includes("No vector column found")) {
          throw new Error(
            `Vector dimension mismatch: query vector has length ${queryEmbedding.length}. Database error: ${msg}`
          );
        }
        throw err;
      }

      const scored: SearchResult[] = [];
      for (const r of rawResults) {
        const rawScore = 1.0 - (r._distance ?? 0);
        const score = Number.isFinite(rawScore) ? Math.max(-1, Math.min(1, rawScore)) : 0;
        let chunk: CodeChunk;
        if (r.chunkJson) {
          try {
            chunk = JSON.parse(r.chunkJson);
          } catch {
            chunk = {
              file: r.file,
              language: r.language,
              symbol: r.symbol,
              type: r.chunkType,
              startLine: r.startLine,
              endLine: r.endLine,
              code: r.code,
              ...(r.parent ? { parent: r.parent } : {}),
            };
          }
        } else {
          chunk = {
            file: r.file,
            language: r.language,
            symbol: r.symbol,
            type: r.chunkType,
            startLine: r.startLine,
            endLine: r.endLine,
            code: r.code,
            ...(r.parent ? { parent: r.parent } : {}),
          };
        }
        scored.push({ chunk, score });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    }

    // In-memory fallback if table has not been persisted to disk yet
    const allRecords = Array.from(this.records.values());
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
}

/**
 * Migrates existing JSON-backed vector records to LanceDB without re-embedding.
 */
export async function migrateJsonToLanceDb(
  jsonPath = DEFAULT_VECTOR_STORE_PATH,
  lanceDbDir = DEFAULT_LANCEDB_DIR,
  tableName = DEFAULT_LANCEDB_TABLE
): Promise<number> {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`JSON vector store file not found at: ${jsonPath}`);
  }

  let content: string;
  try {
    content = await fs.promises.readFile(jsonPath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read vector store file at '${jsonPath}': ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Malformed vector store JSON in file: ${jsonPath}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("records" in parsed) ||
    !Array.isArray((parsed as any).records)
  ) {
    throw new Error(`Invalid vector store schema in file: ${jsonPath}. Missing 'records' array.`);
  }

  const records = (parsed as SerializedVectorStore).records;
  if (records.length === 0) {
    return 0;
  }

  const lanceStore = new LanceDbVectorStore({ dbDir: lanceDbDir, tableName });
  lanceStore.addMany(records);
  await lanceStore.save();

  return records.length;
}

/**
 * Options for resolving the active vector store backend.
 */
export interface ActiveVectorStoreOptions {
  backend?: "lancedb" | "json" | undefined;
  jsonPath?: string | undefined;
  lanceDbDir?: string | undefined;
  tableName?: string | undefined;
  autoMigrate?: boolean | undefined;
}

/**
 * Factory that returns the active vector store (LanceDB by default, with JSON fallback).
 */
export async function getActiveVectorStore(
  options?: ActiveVectorStoreOptions
): Promise<IVectorStore> {
  const jsonPath = options?.jsonPath ?? DEFAULT_VECTOR_STORE_PATH;
  const lanceDbDir = options?.lanceDbDir ?? DEFAULT_LANCEDB_DIR;
  const tableName = options?.tableName ?? DEFAULT_LANCEDB_TABLE;
  const autoMigrate = options?.autoMigrate ?? true;

  const isCustomJsonFile =
    Boolean(
      typeof options?.jsonPath === "string" &&
        options.jsonPath !== DEFAULT_VECTOR_STORE_PATH &&
        options.jsonPath.endsWith(".json")
    );

  const backend =
    options?.backend ??
    (isCustomJsonFile ? "json" : (process.env.VECTOR_STORE_BACKEND ?? DEFAULT_VECTOR_BACKEND));

  if (backend === "json") {
    if (!fs.existsSync(jsonPath)) {
      throw new Error(
        `Vector store file not found at: ${jsonPath}. Please build the repository index first:\n  npm run index`
      );
    }
    const store = new VectorStore();
    await store.loadFromFile(jsonPath);
    return store;
  }

  // Primary: LanceDB
  const lanceTableFile = path.join(lanceDbDir, `${tableName}.lance`);
  const tableExistsOnDisk = fs.existsSync(lanceTableFile);

  if (tableExistsOnDisk) {
    try {
      const lanceStore = new LanceDbVectorStore({ dbDir: lanceDbDir, tableName });
      await lanceStore.load();
      return lanceStore;
    } catch (err: unknown) {
      if (fs.existsSync(jsonPath)) {
        console.warn(
          `[Notice] Failed to open LanceDB table (${err instanceof Error ? err.message : String(err)}). Falling back to JSON vector store.`
        );
        const store = new VectorStore();
        await store.loadFromFile(jsonPath);
        return store;
      }
      throw err;
    }
  }

  // If LanceDB table does not exist on disk, check if JSON store exists to auto-migrate
  if (fs.existsSync(jsonPath) && autoMigrate) {
    try {
      await migrateJsonToLanceDb(jsonPath, lanceDbDir, tableName);
      const lanceStore = new LanceDbVectorStore({ dbDir: lanceDbDir, tableName });
      await lanceStore.load();
      return lanceStore;
    } catch (err: unknown) {
      console.warn(
        `[Notice] Auto-migration from JSON to LanceDB failed (${err instanceof Error ? err.message : String(err)}). Falling back to JSON vector store.`
      );
      const store = new VectorStore();
      await store.loadFromFile(jsonPath);
      return store;
    }
  }

  // Neither exists
  throw new Error(
    `Vector store not found in LanceDB (${lanceDbDir}) or JSON fallback (${jsonPath}). Please build the repository index first:\n  npm run index`
  );
}

/**
 * Checks whether an index is available to query (either LanceDB or JSON fallback).
 */
export function hasVectorIndexAvailable(options?: {
  backend?: "lancedb" | "json" | undefined;
  jsonPath?: string | undefined;
  lanceDbDir?: string | undefined;
  tableName?: string | undefined;
}): boolean {
  const backend = options?.backend ?? process.env.VECTOR_STORE_BACKEND ?? DEFAULT_VECTOR_BACKEND;
  const jsonPath = options?.jsonPath ?? DEFAULT_VECTOR_STORE_PATH;
  const lanceDbDir = options?.lanceDbDir ?? DEFAULT_LANCEDB_DIR;
  const tableName = options?.tableName ?? DEFAULT_LANCEDB_TABLE;
  const lanceTableFile = path.join(lanceDbDir, `${tableName}.lance`);

  if (backend === "json") {
    return fs.existsSync(jsonPath);
  }

  return fs.existsSync(lanceTableFile) || fs.existsSync(jsonPath);
}

/**
 * Indexes a repository: discovers source files, extracts code chunks,
 * generates embeddings, and saves both to LanceDB and the fallback JSON file.
 */
export async function indexRepository(
  rootDir: string,
  storePath = DEFAULT_VECTOR_STORE_PATH,
  options?: GenerateEmbeddingsOptions & {
    backend?: "lancedb" | "json" | undefined;
    lanceDbDir?: string | undefined;
    tableName?: string | undefined;
  }
): Promise<IVectorStore> {
  const chunks = await buildRepoChunks(rootDir);
  const embeddedChunks = await generateEmbeddings(chunks, options);

  const lanceDbDir = options?.lanceDbDir ?? DEFAULT_LANCEDB_DIR;
  const tableName = options?.tableName ?? DEFAULT_LANCEDB_TABLE;
  const backend = options?.backend ?? process.env.VECTOR_STORE_BACKEND ?? DEFAULT_VECTOR_BACKEND;

  // 1. Primary: Save to LanceDB
  const lanceStore = new LanceDbVectorStore({ dbDir: lanceDbDir, tableName });
  lanceStore.addMany(embeddedChunks);
  await lanceStore.save();

  // 2. Secondary / Fallback: Keep JSON store in sync
  const jsonPath = storePath;
  const jsonStore = new VectorStore();
  jsonStore.addMany(embeddedChunks);
  await jsonStore.saveToFile(jsonPath);

  if (backend === "json") {
    return jsonStore;
  }
  return lanceStore;
}

/**
 * Searches the indexed repository using natural language semantic search.
 */
export async function searchCode(
  query: string,
  topK = 5,
  storePathOrOptions?:
    | string
    | (GenerateEmbeddingsOptions & {
        backend?: "lancedb" | "json" | undefined;
        lanceDbDir?: string | undefined;
        tableName?: string | undefined;
      }),
  options?: GenerateEmbeddingsOptions & {
    backend?: "lancedb" | "json" | undefined;
    lanceDbDir?: string | undefined;
    tableName?: string | undefined;
  }
): Promise<SearchResult[]> {
  const storePath =
    typeof storePathOrOptions === "string" ? storePathOrOptions : DEFAULT_VECTOR_STORE_PATH;
  const opts =
    typeof storePathOrOptions === "object" && storePathOrOptions !== null
      ? storePathOrOptions
      : options;

  const store = await getActiveVectorStore({
    backend: opts?.backend,
    jsonPath: storePath,
    lanceDbDir: opts?.lanceDbDir,
    tableName: opts?.tableName,
  });

  const queryEmbedding = await generateQueryEmbedding(query, opts);
  return await store.search(queryEmbedding, topK);
}
