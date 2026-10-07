import { buildRepoChunks } from "./codeChunks.js";
import { generateEmbeddings, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // Ignore if .env does not exist
}

async function main() {
  const isEmbedMode = process.argv.includes("--embed");
  const filteredArgs = process.argv.slice(2).filter((arg) => arg !== "--embed");
  const targetDir = filteredArgs[0] || "sample-repo";

  const chunks = await buildRepoChunks(targetDir);

  console.log(`Generated ${chunks.length} code chunk(s) for "${targetDir}":\n`);
  for (const chunk of chunks) {
    const parentInfo = chunk.parent ? ` (parent: ${chunk.parent})` : "";
    console.log(`--- [${chunk.type.toUpperCase()}] ${chunk.symbol}${parentInfo} (${chunk.file}:${chunk.startLine}-${chunk.endLine}) ---`);
    console.log(chunk.code);
    console.log();
  }

  if (isEmbedMode) {
    console.log("==========================================");
    console.log("Phase 2B: Embedding Generation Pipeline");
    console.log("==========================================");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      console.log("\nNotice: OPENAI_API_KEY environment variable is not configured.");
      console.log("To generate embeddings using OpenAI API:");
      console.log("  1. Copy .env.example to .env or set the environment variable:");
      console.log("     PowerShell: $env:OPENAI_API_KEY = \"your-api-key\"");
      console.log("     Bash/Linux: export OPENAI_API_KEY=\"your-api-key\"");
      console.log("  2. Run: npm run embed\n");
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
    console.log("Tip: Run 'npm run embed' to demonstrate Phase 2B embedding generation.");
  }
}

main().catch((err: unknown) => {
  console.error("Execution failed:", err);
  process.exit(1);
});