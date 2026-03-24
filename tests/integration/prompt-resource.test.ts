import { describe, it, expect } from "vitest";
import {
  MEMORY_GUIDANCE_TEXT,
  registerMemoryGuidance,
} from "../../src/prompts/memory-guidance.js";

/**
 * MCP prompt resource tests (AUTO-02).
 *
 * Tests that the memory-guidance prompt is properly exported and contains
 * the required sections. The MCP SDK registration is tested by verifying
 * the exported constant since the SDK's registerPrompt is integration-tested
 * by the SDK itself.
 */
describe("Memory guidance prompt resource (AUTO-02)", () => {
  it("MEMORY_GUIDANCE_TEXT is exported and contains required sections", () => {
    // Verify it's a non-empty string
    expect(typeof MEMORY_GUIDANCE_TEXT).toBe("string");
    expect(MEMORY_GUIDANCE_TEXT.length).toBeGreaterThan(0);

    // Verify required section headers exist
    expect(MEMORY_GUIDANCE_TEXT).toContain("What to Capture");
    expect(MEMORY_GUIDANCE_TEXT).toContain("When to Save");
    expect(MEMORY_GUIDANCE_TEXT).toContain("Session-End Review");
  });

  it("memory-guidance prompt text contains budget awareness section", () => {
    expect(MEMORY_GUIDANCE_TEXT).toContain("Budget Awareness");
    expect(MEMORY_GUIDANCE_TEXT).toContain("write budget");
  });

  it("memory-guidance prompt text lists memory types to capture", () => {
    // These are the core memory types agents should save
    expect(MEMORY_GUIDANCE_TEXT).toContain("Decisions");
    expect(MEMORY_GUIDANCE_TEXT).toContain("Gotchas");
    expect(MEMORY_GUIDANCE_TEXT).toContain("Patterns");
  });

  it("memory-guidance prompt text explains session-review source", () => {
    // Agents should know to use 'session-review' source for end-of-session saves
    expect(MEMORY_GUIDANCE_TEXT).toContain("session-review");
  });

  it("memory-guidance prompt text mentions force-save with manual source", () => {
    // Agents should know 'manual' source bypasses budget limits
    expect(MEMORY_GUIDANCE_TEXT).toContain("manual");
    expect(MEMORY_GUIDANCE_TEXT).toContain("force-save");
  });

  it("registerMemoryGuidance is a function that accepts an McpServer", () => {
    // Verify the function is exported and has the right shape
    expect(typeof registerMemoryGuidance).toBe("function");

    // Verify it accepts a mock server with registerPrompt method
    const mockServer = {
      registeredPrompts: [] as unknown[],
      registerPrompt(name: string, config: unknown, handler: unknown) {
        this.registeredPrompts.push({ name, config, handler });
      },
    };

    // Should not throw when called with a valid server
    expect(() => {
      registerMemoryGuidance(mockServer as never);
    }).not.toThrow();

    // Should have registered exactly one prompt
    expect(mockServer.registeredPrompts).toHaveLength(1);
    const registered = mockServer.registeredPrompts[0] as {
      name: string;
      config: unknown;
      handler: unknown;
    };
    expect(registered.name).toBe("memory-guidance");
  });
});
