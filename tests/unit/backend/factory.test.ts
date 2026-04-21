import { describe, it, expect } from "vitest";
import { createBackend } from "../../../src/backend/factory.js";

describe("createBackend", () => {
  it("throws when given the vault backend name (not yet implemented)", async () => {
    await expect(
      createBackend({ backend: "vault", databaseUrl: "postgresql://unused" }),
    ).rejects.toThrow(/vault backend is not yet implemented/i);
  });

  it("throws when given an unknown backend name", async () => {
    await expect(
      createBackend({
        // @ts-expect-error — intentionally exercising a runtime-only bad value
        backend: "nosuch",
        databaseUrl: "postgresql://unused",
      }),
    ).rejects.toThrow(/unknown backend/i);
  });
});
