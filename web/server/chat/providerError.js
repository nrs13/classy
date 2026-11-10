export class ChatProviderError extends Error {
  constructor(errorType, status = 0) {
    super(errorType);
    this.name = 'ChatProviderError';
    this.errorType = errorType;
    this.status = status;
  }
}
