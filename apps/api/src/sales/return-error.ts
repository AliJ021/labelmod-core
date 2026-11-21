export class ReturnError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ReturnError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
