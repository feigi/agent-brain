import { DomainError } from "../../utils/errors.js";

// Raised for features not implemented by the vault backend.
// statusHint is 501 so callers distinguish "backend misconfigured"
// from "operation unsupported".
export class NotImplementedError extends DomainError {
  constructor(feature: string) {
    super(
      `${feature} is not implemented by the vault backend`,
      "NOT_IMPLEMENTED",
      501,
    );
  }
}
