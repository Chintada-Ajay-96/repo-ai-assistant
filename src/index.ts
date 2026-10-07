import * as fs from "node:fs";
import { buildRepoChunks } from "./codeChunks.js";
import { generateEmbeddings, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";
import {
  indexRepository,
  searchCode,
  DEFAULT_VECTOR_STORE_PATH,
} from "./vectorStore.js";
import { retrieveRelevantCode, buildContext } from "./retrieval.js";

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // Ignore if .env does not exist
}

function printApiKeyInstructions(command: string) {
  console.log("\nNotice: OPENAI_API_KEY environment variable is not configured.");
  console.log(`To use ${command} with OpenAI API:`);
  console.log("  1. Copy .env.example to .env or set the environment variable:");
  console.log("     PowerShell: $env:OPENAI_API_KEY = \"your-api-key\"");
  console.log("     Bash/Linux: export OPENAI_API_KEY=\"your-api-key\"");
  console.log(`  2. Run: npm run ${command}\n`);
}

async function main() {
  const isEmbedMode = process.argv.includes("--embed");
  const isIndexMode = process.argv.includes("--index");
  const isSearchMode = process.argv.includes("--search");
  const isRetrieveMode = process.argv.includes("--retrieve");

  // Filter out CLI option flags to obtain positional arguments
  const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

  // 1. Retrieval & Context Preparation Mode (Phase 2D)
  if (isRetrieveMode) {
    console.log("==========================================");
    console.log("Code Retrieval (Phase 2D)");
    console.log("==========================================");

    const query = positionalArgs.join(" ").trim();
    if (!query) {
      console.log("\nPlease provide a retrieval query.");
      console.log('Example: npm run retrieve -- "Where is authentication handled?"\n');
      return;
    }

    if (!fs.existsSync(DEFAULT_VECTOR_STORE_PATH)) {
      console.log(`\nVector store not found at ${DEFAULT_VECTOR_STORE_PATH}.`);
      console.log("Please build the repository vector index first:\n  npm run index\n");
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      printApiKeyInstructions("retrieve");
      return;
    }

    console.log("\nQuery:");
    console.log(query);

    const retrieval = await retrieveRelevantCode(query);
    const contextResult = buildContext(retrieval.results);

    console.log("\nRetrieved chunks:\n");
    if (retrieval.results.length === 0) {
      console.log("No relevant code chunks found.");
    } else {
      retrieval.results.forEach((res, index) => {
        console.log(`${index + 1}. ${res.chunk.symbol}`);
        console.log(`   File: ${res.chunk.file}`);
        console.log(`   Score: ${res.score.toFixed(4)}\n`);
      });
    }

    console.log("==========================================");
    console.log("LLM CONTEXT");
    console.log("==========================================\n");

    if (contextResult.includedChunks === 0) {
      console.log("(No context generated)\n");
    } else {
      console.log(contextResult.context);
      console.log();
    }
    return;
  }

  // 2. Semantic Search Mode
  if (isSearchMode) {
    console.log("==========================================");
    console.log("Semantic Search (Phase 2C)");
    console.log("==========================================");

    const query = positionalArgs.join(" ").trim();
    if (!query) {
      console.log("\nPlease provide a search query.");
      console.log('Example: npm run search -- "Where is authentication handled?"\n');
      return;
    }

    if (!fs.existsSync(DEFAULT_VECTOR_STORE_PATH)) {
      console.log(`\nVector store not found at ${DEFAULT_VECTOR_STORE_PATH}.`);
      console.log("Please build the repository vector index first:\n  npm run index\n");
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      printApiKeyInstructions("search");
      return;
    }

    console.log(`\nQuery: ${query}\n`);
    const results = await searchCode(query, 5);

    if (results.length === 0) {
      console.log("No relevant code chunks found.");
      return;
    }

    results.forEach((res, index) => {
      console.log(`${index + 1}. ${res.chunk.symbol}`);
      console.log(`   File: ${res.chunk.file}`);
      console.log(`   Lines: ${res.chunk.startLine}-${res.chunk.endLine}`);
      console.log(`   Type: ${res.chunk.type}`);
      if (res.chunk.parent) {
        console.log(`   Parent: ${res.chunk.parent}`);
      }
      console.log(`   Similarity: ${res.score.toFixed(4)}\n`);
      console.log(`   ${res.chunk.code.split("\n").join("\n   ")}\n`);
    });
    return;
  }

  // 2. Indexing Mode
  if (isIndexMode) {
    console.log("==========================================");
    console.log("Repository Indexing Pipeline (Phase 2C)");
    console.log("==========================================");

    const targetDir = positionalArgs[0] || "sample-repo";
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey || apiKey.trim() === "") {
      printApiKeyInstructions("index");
      return;
    }

    console.log(`Indexing repository "${targetDir}"...`);
    const store = await indexRepository(targetDir, DEFAULT_VECTOR_STORE_PATH);
    console.log(`Successfully indexed ${store.size()} code chunk(s).`);
    console.log(`Vector store saved to: ${DEFAULT_VECTOR_STORE_PATH}`);
    console.log("\nYou can now query the index:");
    console.log('  npm run search -- "Where is authentication handled?"\n');
    return;
  }

  // Default / Embed Mode: build and display chunks
  const targetDir = positionalArgs[0] || "sample-repo";
  const chunks = await buildRepoChunks(targetDir);

  console.log(`Generated ${chunks.length} code chunk(s) for "${targetDir}":\n`);
  for (const chunk of chunks) {
    const parentInfo = chunk.parent ? ` (parent: ${chunk.parent})` : "";
    console.log(`--- [${chunk.type.toUpperCase()}] ${chunk.symbol}${parentInfo} (${chunk.file}:${chunk.startLine}-${chunk.endLine}) ---`);
    console.log(chunk.code);
    console.log();
  }

  // 3. Embedding Mode
  if (isEmbedMode) {
    console.log("==========================================");
    console.log("Phase 2B: Embedding Generation Pipeline");
    console.log("==========================================");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      printApiKeyInstructions("embed");
      return;
    }

    console.log(`Generating embeddings using model: ${DEFAULT_EMBEDDING_MODEL}...`);
    const embeddedChunks = await generateEmbeddings(chunks);

    for (const ec of embeddedChunks) {
      console.log(`  ✓ ${ec.chunk.symbol} (${ec.chunk.type})`);
    }

    if (embeddedChunks.length > 0) {
      const dimension = embeddedChunks[0]?.embedding.length ?? 0;
      console.log(`\nSuccessfully generated ${embeddedChunks.length} embeddings.`);
      console.log(`Embedding vector dimension: ${dimension}`);
      const preview = embeddedChunks[0]?.embedding.slice(0, 4).map((n) => n.toFixed(4)).join(", ");
      console.log(`Sample vector preview [${preview}, ...]`);
    }
  } else {
    console.log("Available Commands:");
    console.log("  - npm run embed   : Generate and inspect embeddings (Phase 2B)");
    console.log("  - npm run index   : Build and persist local vector index (Phase 2C)");
    console.log("  - npm run search -- \"query\"   : Perform semantic search (Phase 2C)");
    console.log("  - npm run retrieve -- \"query\" : Retrieve code & build LLM context (Phase 2D)\n");
  }
}

main().catch((err: unknown) => {
  console.error("Execution failed:", err);
  process.exit(1);
});