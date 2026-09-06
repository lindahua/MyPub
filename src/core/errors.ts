export class MyPubError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = "MyPubError";
  }
}

export const fail = (message: string, code: string, details?: unknown): never => {
  throw new MyPubError(message, code, details);
};
