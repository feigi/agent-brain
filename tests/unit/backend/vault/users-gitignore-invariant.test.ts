import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUsersIgnored } from "../../../../src/backend/vault/git/users-gitignore-invariant.js";
import { DomainError } from "../../../../src/utils/errors.js";

describe("assertUsersIgnored", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "users-ignore-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes when .gitignore contains users/", async () => {
    await writeFile(join(root, ".gitignore"), "users/\n", "utf8");
    await expect(assertUsersIgnored(root)).resolves.toBeUndefined();
  });

  it("passes when the rule is users/**", async () => {
    await writeFile(join(root, ".gitignore"), "users/**\n", "utf8");
    await expect(assertUsersIgnored(root)).resolves.toBeUndefined();
  });

  it("throws a DomainError when .gitignore missing", async () => {
    await expect(assertUsersIgnored(root)).rejects.toThrow(DomainError);
  });

  it("throws when the users/ rule is absent", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules\n", "utf8");
    await expect(assertUsersIgnored(root)).rejects.toThrow(/users\//);
  });
});
