import { GoogleGenAI } from "@google/genai";

// Load environment variables from .env if present
try {
  process.loadEnvFile();
} catch {
  // Ignore if .env does not exist
}

/**
 * Default Gemini Flash model used for answer generation.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Provider-agnostic interface for LLM text generation.
 * Can be implemented by other LLM providers (e.g. OpenAI, Anthropic, local) in future phases.
 */
export interface LLMClient {
  generateText(prompt: string): Promise<string>;
}

/**
 * Minimal structural interface for Gemini SDK client dependency injection.
 * Allows unit tests to provide a mock client without network access.
 */
export interface GeminiSdkClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
    }): Promise<{
      text?: string | undefined;
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string | undefined }>;
        };
      }> | undefined;
    }>;
  };
}

/**
 * Configuration options for GeminiClient.
 */
export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  sdkClient?: GeminiSdkClient;
}

/**
 * Gemini LLM implementation of the LLMClient interface using the official @google/genai SDK.
 */
export class GeminiClient implements LLMClient {
  private readonly model: string;
  private readonly client: GeminiSdkClient;

  constructor(options?: GeminiClientOptions) {
    this.model = options?.model && options.model.trim() !== ""
      ? options.model.trim()
      : DEFAULT_GEMINI_MODEL;

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
   * Returns the configured Gemini model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Generates text from a given prompt using Gemini.
   */
  async generateText(prompt: string): Promise<string> {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("Prompt cannot be empty.");
    }

    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt.trim(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate text with Gemini: ${message}`);
    }

    let text = response?.text;
    if (text === undefined && response?.candidates?.[0]?.content?.parts) {
      text = response.candidates[0].content.parts
        .map((p) => p.text ?? "")
        .join("");
    }

    return text ?? "";
  }
}

/**
 * Factory helper function to instantiate a GeminiClient.
 */
export function createGeminiClient(options?: GeminiClientOptions): GeminiClient {
  return new GeminiClient(options);
}

/**
 * Convenience helper function to generate text from a prompt using Gemini.
 */
export async function generateText(
  prompt: string,
  options?: GeminiClientOptions
): Promise<string> {
  const client = new GeminiClient(options);
  return client.generateText(prompt);
}
