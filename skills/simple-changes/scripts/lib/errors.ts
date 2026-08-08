export class SimpleChangesError extends Error {
  readonly exitCode: number;

  static withCause(
    message: string,
    exitCode: number,
    cause: unknown
  ): SimpleChangesError {
    return new SimpleChangesError(message, exitCode, { cause });
  }

  constructor(message: string, exitCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimpleChangesError";
    this.exitCode = exitCode;
  }
}

export const EXIT_CODES = {
  inventory: 4,
  success: 0,
  unsafe: 5,
  usage: 2,
  validation: 3,
} as const;
