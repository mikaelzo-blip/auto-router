export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class AppError extends Error {
  public statusCode?: number;
  public isRetryable?: boolean;

  constructor(message: string, statusCode?: number, isRetryable?: boolean) {
    super(message);
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
  }
}

export class RetryPolicy {
  private readonly options: RetryOptions;

  constructor(options: RetryOptions) {
    this.options = options;
  }

  public async execute<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        return await operation(attempt);
      } catch (err: any) {
        lastError = err;

        // DEFECT: Blindly retries ALL errors, including unretryable 4xx errors!
        if (attempt === this.options.maxAttempts) {
          break;
        }

        // Delay
        const delay = this.options.baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, Math.min(10, delay))); // bounded in tests
      }
    }

    throw lastError;
  }
}
