export class ChatProviderError extends Error {
  constructor(errorType, status = 0, extra = {}) {
    super(errorType);
    this.name = 'ChatProviderError';
    this.errorType = errorType;
    this.status = status;
    this.scope = extra.scope || errorType;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.resetAt = extra.resetAt ?? null;
  }
}
