import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiClient,
  createGeminiClient,
  generateText,
  DEFAULT_GEMINI_MODEL,
  type GeminiSdkClient,
  type LLMClient,
} from "../src/llm.js";

describe("llm - LLM Answer Generation Client (Phase 3A)", () => {
  function createMockSdkClient(options?: {
    responseText?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    errorToThrow?: Error | string;
    onCall?: (params: { model: string; contents: string }) => void;
  }): GeminiSdkClient {
    return {
      models: {
        async generateContent(params: { model: string; contents: string }) {
          if (options?.onCall) {
            options.onCall(params);
          }
          if (options?.errorToThrow) {
            if (typeof options.errorToThrow === "string") {
              throw new Error(options.errorToThrow);
            }
            throw options.errorToThrow;
          }
          return {
            text: options?.responseText,
            candidates: options?.candidates,
          };
        },
      },
    };
  }

  describe("Interface & Initialization", () => {
    it("should implement the LLMClient interface", () => {
      const mockSdk = createMockSdkClient({ responseText: "hello" });
      const client: LLMClient = new GeminiClient({ sdkClient: mockSdk });
      assert.equal(typeof client.generateText, "function");
    });

    it("should use DEFAULT_GEMINI_MODEL by default", () => {
      const mockSdk = createMockSdkClient();
      const client = new GeminiClient({ sdkClient: mockSdk });
      assert.equal(client.getModel(), DEFAULT_GEMINI_MODEL);
      assert.equal(client.getModel(), "gemini-2.5-flash");
    });

    it("should allow configuring a custom model", () => {
      const mockSdk = createMockSdkClient();
      const client = new GeminiClient({
        model: "gemini-2.0-flash",
        sdkClient: mockSdk,
      });
      assert.equal(client.getModel(), "gemini-2.0-flash");
    });

    it("should instantiate with an explicit apiKey without calling network APIs", () => {
      const client = new GeminiClient({ apiKey: "test-valid-key" });
      assert.ok(client instanceof GeminiClient);
      assert.equal(client.getModel(), DEFAULT_GEMINI_MODEL);
    });

    it("should throw a clear error when GEMINI_API_KEY is missing", () => {
      const originalApiKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        assert.throws(
          () => new GeminiClient(),
          /Missing Gemini API key\. Please set the GEMINI_API_KEY environment variable\./
        );
        assert.throws(
          () => new GeminiClient({ apiKey: "" }),
          /Missing Gemini API key\. Please set the GEMINI_API_KEY environment variable\./
        );
        assert.throws(
          () => new GeminiClient({ apiKey: "   " }),
          /Missing Gemini API key\. Please set the GEMINI_API_KEY environment variable\./
        );
      } finally {
        if (originalApiKey !== undefined) {
          process.env.GEMINI_API_KEY = originalApiKey;
        }
      }
    });

    it("should read GEMINI_API_KEY from process.env when present", () => {
      const originalApiKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "env-test-key";

      try {
        const client = new GeminiClient();
        assert.ok(client instanceof GeminiClient);
      } finally {
        if (originalApiKey !== undefined) {
          process.env.GEMINI_API_KEY = originalApiKey;
        } else {
          delete process.env.GEMINI_API_KEY;
        }
      }
    });
  });

  describe("generateText", () => {
    it("should successfully generate text from prompt", async () => {
      const expectedText = "The AuthService handles login and token generation.";
      const mockSdk = createMockSdkClient({ responseText: expectedText });
      const client = new GeminiClient({ sdkClient: mockSdk });

      const result = await client.generateText("Explain the AuthService class.");
      assert.equal(result, expectedText);
    });

    it("should pass prompt and model correctly to the underlying SDK", async () => {
      let capturedParams: { model: string; contents: string } | null = null;
      const mockSdk = createMockSdkClient({
        responseText: "Response",
        onCall(params) {
          capturedParams = params;
        },
      });

      const client = new GeminiClient({
        model: "gemini-2.0-flash",
        sdkClient: mockSdk,
      });

      await client.generateText("Where is authentication handled?");

      assert.ok(capturedParams !== null);
      assert.equal((capturedParams as any).model, "gemini-2.0-flash");
      assert.equal((capturedParams as any).contents, "Where is authentication handled?");
    });

    it("should handle empty or whitespace-only prompts with a clear error", async () => {
      const mockSdk = createMockSdkClient({ responseText: "response" });
      const client = new GeminiClient({ sdkClient: mockSdk });

      await assert.rejects(
        async () => client.generateText(""),
        /Prompt cannot be empty\./
      );

      await assert.rejects(
        async () => client.generateText("   \n\t  "),
        /Prompt cannot be empty\./
      );
    });

    it("should handle provider/API errors clearly", async () => {
      const mockSdk = createMockSdkClient({
        errorToThrow: new Error("Resource has been exhausted (e.g. check quota)."),
      });
      const client = new GeminiClient({ sdkClient: mockSdk });

      await assert.rejects(
        async () => client.generateText("Explain this code"),
        /Failed to generate text with Gemini: Resource has been exhausted/
      );
    });

    it("should handle empty response text safely without crashing", async () => {
      const mockSdk = createMockSdkClient({ responseText: "" });
      const client = new GeminiClient({ sdkClient: mockSdk });

      const result = await client.generateText("Explain this");
      assert.equal(result, "");
    });

    it("should handle missing text property in response safely", async () => {
      const mockSdk = createMockSdkClient({});
      const client = new GeminiClient({ sdkClient: mockSdk });

      const result = await client.generateText("Explain this");
      assert.equal(result, "");
    });

    it("should extract text from candidates if top-level text is undefined", async () => {
      const mockSdk = createMockSdkClient({
        candidates: [
          {
            content: {
              parts: [{ text: "Extracted from candidate parts." }],
            },
          },
        ],
      });
      const client = new GeminiClient({ sdkClient: mockSdk });

      const result = await client.generateText("Explain this");
      assert.equal(result, "Extracted from candidate parts.");
    });
  });

  describe("Helper Functions", () => {
    it("createGeminiClient should return a functioning GeminiClient instance", async () => {
      const mockSdk = createMockSdkClient({ responseText: "Factory output" });
      const client = createGeminiClient({ sdkClient: mockSdk });

      assert.ok(client instanceof GeminiClient);
      const text = await client.generateText("Test");
      assert.equal(text, "Factory output");
    });

    it("generateText convenience function should generate text using GeminiClient", async () => {
      const mockSdk = createMockSdkClient({ responseText: "Convenience output" });
      const text = await generateText("Test prompt", { sdkClient: mockSdk });

      assert.equal(text, "Convenience output");
    });
  });
});
