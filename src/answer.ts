import {
  retrieveRelevantCode,
  buildContext,
  type RetrievedChunk,
  type RetrieveOptions,
  type BuildContextOptions,
} from "./retrieval.js";
import { type LLMClient } from "./llm.js";

/**
 * Result of RAG answer generation.
 */
export interface AnswerResult {
  answer: string;
  retrievedChunks: number;
  contextCharacters: number;
  question?: string | undefined;
  retrievedResults?: RetrievedChunk[] | undefined;
}

/**
 * Input for RAG prompt construction.
 */
export interface RagPromptInput {
  context: string;
  question: string;
}

/**
 * Options for RAG answer generation.
 * An LLMClient must be injected, ensuring the orchestration layer remains provider-agnostic.
 */
export interface RetrieveAndAnswerOptions {
  llmClient: LLMClient;
  retrieveOptions?: RetrieveOptions | undefined;
  contextOptions?: BuildContextOptions | undefined;
}

/**
 * Constructs a grounded prompt separating repository context, user question,
 * and grounding instructions.
 */
export function buildRagPrompt({ context, question }: RagPromptInput): string {
  return [
    "Repository Context:",
    context,
    "",
    "User Question:",
    question,
    "",
    "Instructions:",
    "- You are answering questions about a software repository.",
    "- The supplied repository context is the primary source of truth.",
    "- Answer using the provided repository context.",
    "- You must not invent files, functions, classes, variables, APIs, or behavior that are not supported by the retrieved context.",
    "- If the retrieved context is insufficient, explicitly state that the available repository context is insufficient to answer confidently.",
    "- Mention relevant file paths and symbols when useful.",
    "- Explain code clearly for a developer.",
    "- For flow questions, explain the flow using only the retrieved repository context.",
    "- Do not claim that you inspected files that were not included in the context.",
    "",
    "Answer:",
  ].join("\n");
}

/**
 * Orchestrates complete RAG answer generation:
 * 1. Validates the question.
 * 2. Retrieves relevant code chunks from the vector store.
 * 3. Builds structured context within character budget.
 * 4. Handles empty retrieval safely without hallucination.
 * 5. Constructs the grounded prompt.
 * 6. Invokes the LLM client and returns the answer with metadata.
 */
export async function retrieveAndAnswer(
  question: string,
  options: RetrieveAndAnswerOptions
): Promise<AnswerResult> {
  if (typeof question !== "string" || question.trim() === "") {
    throw new Error("Question cannot be empty.");
  }

  if (!options || !options.llmClient) {
    throw new Error("An LLMClient must be provided via options.llmClient.");
  }

  const trimmedQuestion = question.trim();

  // 1. Retrieve relevant code chunks
  const retrieval = await retrieveRelevantCode(
    trimmedQuestion,
    options.retrieveOptions
  );

  // 2. Build structured repository context
  const contextResult = buildContext(
    retrieval.results,
    options.contextOptions
  );

  // 3. Handle empty retrieval safely
  if (retrieval.results.length === 0 || contextResult.includedChunks === 0) {
    return {
      answer: `No relevant repository context was found to answer the question: "${trimmedQuestion}".`,
      retrievedChunks: 0,
      contextCharacters: 0,
      question: trimmedQuestion,
      retrievedResults: [],
    };
  }

  // 4. Construct grounded prompt
  const prompt = buildRagPrompt({
    context: contextResult.context,
    question: trimmedQuestion,
  });

  // 5. Send to injected LLM client
  const answer = await options.llmClient.generateText(prompt);

  return {
    answer,
    retrievedChunks: contextResult.includedChunks,
    contextCharacters: contextResult.totalCharacters,
    question: trimmedQuestion,
    retrievedResults: retrieval.results,
  };
}
