import * as fs from "node:fs";
import { buildRepoChunks } from "./codeChunks.js";
import { generateEmbeddings, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";
import {
  indexRepository,
  searchCode,
  DEFAULT_VECTOR_STORE_PATH,
} from "./vectorStore.js";
import { retrieveRelevantCode, buildContext } from "./retrieval.js";
import { retrieveAndAnswer } from "./answer.js";
import { GeminiClient } from "./llm.js";
import {
  analyzeChangeTarget,
  AmbiguousTargetError,
  StaleIndexError,
  EmptyRetrievalError,
  NoMatchingTargetError,
  TargetFileNotFoundError,
} from "./changeAnalysis.js";
import {
  generateChangeFromContext,
  MalformedModelResponseError,
  LLMGenerationError,
} from "./changeGenerator.js";
import { validateProposedChange } from "./changeValidation.js";
import { discoverTests } from "./testDiscovery.js";
import { verifyProposedChange } from "./verification/index.js";

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // Ignore if .env does not exist
}

export interface ParsedProposeArgs {
  instruction: string;
  targetFile?: string | undefined;
  targetSymbol?: string | undefined;
  verify?: boolean | undefined;
  error?: string | undefined;
}

/**
 * Parses CLI arguments for the --propose command.
 * Correctly extracts instruction, --file, and --symbol hints without leaking flag values into the instruction.
 */
export function parseProposeArgs(args: string[]): ParsedProposeArgs {
  let targetFile: string | undefined;
  let targetSymbol: string | undefined;
  let verify = false;
  const instructionTokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--propose") {
      continue;
    }

    if (arg === "--verify") {
      verify = true;
      continue;
    }

    if (arg === "--file") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        return {
          instruction: "",
          error: "Missing value for --file flag. Expected a file path.",
        };
      }
      targetFile = next;
      i++;
      continue;
    }

    if (arg === "--symbol") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        return {
          instruction: "",
          error: "Missing value for --symbol flag. Expected a symbol name.",
        };
      }
      targetSymbol = next;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      continue;
    }

    instructionTokens.push(arg);
  }

  const instruction = instructionTokens.join(" ").trim();
  return {
    instruction,
    targetFile,
    targetSymbol,
    verify,
  };
}

function printGeminiApiKeyInstructions(command: string) {
  console.log("\nNotice: GEMINI_API_KEY environment variable is not configured.");
  console.log(`To use ${command} with Gemini API:`);
  console.log("  1. Copy .env.example to .env or set the environment variable:");
  console.log("     PowerShell: $env:GEMINI_API_KEY = \"your-api-key\"");
  console.log("     Bash/Linux: export GEMINI_API_KEY=\"your-api-key\"");
  console.log(`  2. Run: npm run ${command}\n`);
}

async function main() {
  const isEmbedMode = process.argv.includes("--embed");
  const isIndexMode = process.argv.includes("--index");
  const isSearchMode = process.argv.includes("--search");
  const isRetrieveMode = process.argv.includes("--retrieve");
  const isAskMode = process.argv.includes("--ask");
  const isProposeMode = process.argv.includes("--propose");

  // Filter out CLI option flags to obtain positional arguments
  const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

  // 1. Code Change Assistance Mode (Phase 4)
  if (isProposeMode) {
    console.log("==========================================");
    console.log("Code Change Assistance (Phase 4)");
    console.log("==========================================");

    const parsed = parseProposeArgs(process.argv.slice(2));
    if (parsed.error) {
      console.log(`\nError: ${parsed.error}`);
      console.log('Example: npm run propose -- "Add validation to verifyToken" --file sample-repo/auth.js --symbol verifyToken\n');
      return;
    }

    if (!parsed.instruction) {
      console.log("\nPlease provide a change instruction.");
      console.log('Example: npm run propose -- "Add validation to verifyToken"\n');
      console.log("Optional hints:");
      console.log("  --file <path>    Specify target file path to disambiguate");
      console.log("  --symbol <name>  Specify target symbol name to disambiguate\n");
      return;
    }

    if (!fs.existsSync(DEFAULT_VECTOR_STORE_PATH)) {
      console.log(`\nVector store not found at ${DEFAULT_VECTOR_STORE_PATH}.`);
      console.log("Please build the repository vector index first:\n  npm run index\n");
      return;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("propose");
      return;
    }

    console.log("\nInstruction:");
    console.log(parsed.instruction);
    if (parsed.targetFile) {
      console.log(`Target File Hint: ${parsed.targetFile}`);
    }
    if (parsed.targetSymbol) {
      console.log(`Target Symbol Hint: ${parsed.targetSymbol}`);
    }
    console.log();

    try {
      // 1. Phase 4A: Target Analysis & Line Verification
      console.log("1. Analyzing repository and identifying target symbol...");
      const context = await analyzeChangeTarget(parsed.instruction, {
        targetFile: parsed.targetFile,
        targetSymbol: parsed.targetSymbol,
      });

      console.log(`   ✓ Target identified: ${context.target.file} :: ${context.target.symbol} (${context.target.type}, lines ${context.target.startLine}-${context.target.endLine})`);
      console.log(`   ✓ Source verified against disk (similarity: ${context.target.score.toFixed(4)})`);
      if (context.references.length > 0) {
        console.log(`   ✓ Retrieved ${context.references.length} reference context chunk(s)`);
      }

      // 2. Phase 4B: Code Change Generation
      console.log("\n2. Generating proposed replacement with Gemini (gemini-2.5-flash)...");
      const geminiClient = new GeminiClient();
      const proposal = await generateChangeFromContext(context, {
        llmClient: geminiClient,
      });
      console.log("   ✓ Proposed replacement and unified diff generated.");

      // 3. Phase 4C: In-Memory Validation & AST Syntax Check
      console.log("\n3. Validating proposed change and verifying Tree-sitter AST syntax...");
      const plan = await validateProposedChange(proposal);

      console.log("\n" + plan.preview);

      if (plan.isValid) {
        console.log("\n==========================================");
        console.log("Summary: Proposed change is syntactically valid and ready for review.");
        console.log("Notice: This was a dry-run. No files on disk were modified.");
        console.log("==========================================\n");

        if (parsed.verify || process.argv.includes("--verify")) {
          console.log("4. Running isolated behavioral verification (Phase 5B)...");
          const testDiscovery = await discoverTests({
            repoRoot: process.cwd(),
            targetFile: plan.proposal.file,
            targetSymbol: plan.proposal.symbol,
          });

          console.log(`   ✓ Discovered ${testDiscovery.tests.length} candidate test(s)`);
          const verification = await verifyProposedChange({
            validatedPlan: plan,
            testDiscovery,
            repoRoot: process.cwd(),
          });

          console.log("\n==========================================");
          console.log(`Verification Status: ${verification.status.toUpperCase()}`);
          console.log("==========================================");
          if (verification.failureReason) {
            console.log(`Details: ${verification.failureReason}`);
          }
          if (verification.executionSummary) {
            console.log(
              `Tests: ${verification.executionSummary.passed} passed, ${verification.executionSummary.failed} failed, ${verification.executionSummary.skipped} skipped, ${verification.executionSummary.todo} todo (${verification.executionSummary.totalReported} total)`
            );
          }
          console.log(`Cleanup: ${verification.cleanupStatus}`);
          console.log(`\n${verification.securityNotice}`);
          console.log(`\n${verification.semanticDisclaimer}\n`);
        }
      } else {
        console.log("\n==========================================");
        console.log("Summary: Proposed change failed validation.");
        console.log("Notice: No files on disk were modified.");
        console.log("==========================================\n");
      }
    } catch (err: unknown) {
      if (err instanceof AmbiguousTargetError) {
        console.log("\n==========================================");
        console.log("Ambiguous Change Target");
        console.log("==========================================");
        console.log("The change instruction matched multiple candidate symbols with similar relevance:\n");
        err.candidates.forEach((cand, idx) => {
          console.log(`  ${idx + 1}. ${cand.chunk.symbol} (${cand.chunk.type})`);
          console.log(`     File: ${cand.chunk.file}:${cand.chunk.startLine}-${cand.chunk.endLine}`);
          console.log(`     Similarity: ${cand.score.toFixed(4)}\n`);
        });
        console.log("To resolve this ambiguity, provide a target hint:");
        console.log(`  npm run propose -- "${parsed.instruction}" --symbol <symbol_name>`);
        console.log(`  npm run propose -- "${parsed.instruction}" --file <file_path>\n`);
        return;
      }

      if (err instanceof StaleIndexError) {
        console.log("\n==========================================");
        console.log("Stale Repository Index Detected");
        console.log("==========================================");
        console.log(`File: ${err.file} (lines ${err.startLine}-${err.endLine})`);
        console.log("The current code on disk does not match the indexed code in .data/vector-store.json.");
        console.log("\nTo fix this, please re-index the repository:");
        console.log("  npm run index\n");
        return;
      }

      if (err instanceof EmptyRetrievalError) {
        console.log("\n==========================================");
        console.log("No Matching Code Found");
        console.log("==========================================");
        console.log(`No relevant repository code was found for: "${parsed.instruction}"`);
        console.log("Please check your instruction or re-index the repository: npm run index\n");
        return;
      }

      if (err instanceof NoMatchingTargetError) {
        console.log("\n==========================================");
        console.log("Target Hint Not Found");
        console.log("==========================================");
        console.log(err.message);
        console.log("Please verify the --file or --symbol hints provided.\n");
        return;
      }

      if (err instanceof TargetFileNotFoundError) {
        console.log("\n==========================================");
        console.log("Target File Not Found");
        console.log("==========================================");
        console.log(`File: ${err.file}`);
        console.log("The target file does not exist on disk. Please re-index the repository with 'npm run index'.\n");
        return;
      }

      if (err instanceof MalformedModelResponseError) {
        console.log("\n==========================================");
        console.log("Model Response Format Error");
        console.log("==========================================");
        console.log(err.message);
        console.log("The AI model returned an unparseable response. Please try running the command again.\n");
        return;
      }

      if (err instanceof LLMGenerationError) {
        console.log("\n==========================================");
        console.log("AI Generation Error");
        console.log("==========================================");
        console.log(err.message);
        console.log("Failed to communicate with the Gemini API. Please check your network and API key.\n");
        return;
      }

      console.error("\nUnexpected error during change proposal execution:", err);
    }
    return;
  }

  // 2. Complete RAG Answer Generation Mode (Phase 3B)
  if (isAskMode) {
    console.log("==========================================");
    console.log("RAG Answer Generation (Phase 3B)");
    console.log("==========================================");

    const question = positionalArgs.join(" ").trim();
    if (!question) {
      console.log("\nPlease provide a question to ask.");
      console.log('Example: npm run ask -- "Where is authentication handled?"\n');
      return;
    }

    if (!fs.existsSync(DEFAULT_VECTOR_STORE_PATH)) {
      console.log(`\nVector store not found at ${DEFAULT_VECTOR_STORE_PATH}.`);
      console.log("Please build the repository vector index first:\n  npm run index\n");
      return;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("ask");
      return;
    }

    console.log("\nQuestion:");
    console.log(question);
    console.log("\nRetrieving repository context and generating grounded answer...\n");

    const geminiClient = new GeminiClient();
    const result = await retrieveAndAnswer(question, {
      llmClient: geminiClient,
    });

    console.log("==========================================");
    console.log("Answer:");
    console.log("==========================================\n");
    console.log(result.answer);
    console.log(`\n(Retrieved ${result.retrievedChunks} chunk(s), ${result.contextCharacters} context characters)\n`);
    return;
  }

  // 2. Retrieval & Context Preparation Mode (Phase 2D)
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

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("retrieve");
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

  // 3. Semantic Search Mode (Phase 2C)
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

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("search");
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

  // 4. Indexing Mode (Phase 2C)
  if (isIndexMode) {
    console.log("==========================================");
    console.log("Repository Indexing Pipeline (Phase 2C)");
    console.log("==========================================");

    const targetDir = positionalArgs[0] || "sample-repo";
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("index");
      return;
    }

    console.log(`Indexing repository "${targetDir}" using Gemini (${DEFAULT_EMBEDDING_MODEL})...`);
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

  // 5. Embedding Mode (Phase 2B-G)
  if (isEmbedMode) {
    console.log("==========================================");
    console.log("Phase 2B-G: Gemini Embedding Generation Pipeline");
    console.log("==========================================");

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.trim() === "") {
      printGeminiApiKeyInstructions("embed");
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
    console.log("  - npm run embed   : Generate and inspect embeddings (Phase 2B-G)");
    console.log("  - npm run index   : Build and persist local vector index (Phase 2C)");
    console.log("  - npm run search -- \"query\"   : Perform semantic search (Phase 2C)");
    console.log("  - npm run retrieve -- \"query\" : Retrieve code & build LLM context (Phase 2D)");
    console.log("  - npm run ask -- \"question\"   : Grounded RAG answer generation (Phase 3B)");
    console.log("  - npm run propose -- \"instruction\" : Propose and validate code change (Phase 4)\n");
  }
}

main().catch((err: unknown) => {
  console.error("Execution failed:", err);
  process.exit(1);
});