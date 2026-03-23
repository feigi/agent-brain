export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint?: number
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class EmbeddingError extends DomainError {
  constructor(message: string) {
    super(message, "EMBEDDING_ERROR", 502);
  }
}
