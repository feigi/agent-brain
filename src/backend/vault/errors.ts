import { DomainError } from "../../utils/errors.js";

// Raised by vault repositories for methods that require the vector
// index, which is filled in Phase 3. The statusHint is 501 so callers
// distinguish "backend misconfigured" from "operation unsupported".
export class NotImplementedError extends DomainError {
  constructor(feature: string) {
    super(
      `${feature} is not implemented by the vault backend (phase-3)`,
      "NOT_IMPLEMENTED",
      501,
    );
  }
}
