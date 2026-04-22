import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../../../utils/errors.js";

// Hard-fails a user-scope write if `.gitignore` no longer contains the
// privacy rule that keeps users/ out of the shared remote. Spec: vault
// backend §users — rule is load-bearing for privacy.
export async function assertUsersIgnored(root: string): Promise<void> {
  let body: string;
  try {
    body = await readFile(join(root, ".gitignore"), "utf8");
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new DomainError(
        ".gitignore is missing — refusing user-scope write (privacy guard)",
        "VAULT_USERS_NOT_IGNORED",
        500,
      );
    }
    throw err;
  }
  const rules = new Set(body.split(/\r?\n/).map((l) => l.trim()));
  if (rules.has("users/") || rules.has("users/**")) return;
  throw new DomainError(
    ".gitignore missing 'users/' rule — refusing user-scope write (privacy guard)",
    "VAULT_USERS_NOT_IGNORED",
    500,
  );
}
