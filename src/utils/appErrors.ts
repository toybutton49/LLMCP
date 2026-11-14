export type AppErrorCode =
  | 'CHAT_MODEL_UNAVAILABLE'
  | 'EMBEDDING_MODEL_REQUIRED'
  | 'EMBEDDING_MODEL_UNAVAILABLE'
  | 'EMBEDDING_RETRIEVAL_FAILED'
  | 'OCR_MODEL_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'INFERENCE_FAILED'
  | 'LLAMA_ROUTER_UNAVAILABLE'
  | 'RUNTIME_PREFLIGHT_FAILED'
  | 'TTS_UNAVAILABLE'
  | 'INVALID_ATTACHMENT'
  | 'FILE_ALREADY_EXISTS';

export interface AppErrorPayload {
  error: string;
  code: AppErrorCode;
  feature: string;
  action: string;
}

export interface AppErrorFallback {
  code: AppErrorCode;
  feature: string;
  action: string;
  messagePrefix?: string;
}

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly feature: string,
    message: string,
    public readonly action: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toAppErrorPayload(error: unknown, fallback: AppErrorFallback): AppErrorPayload {
  if (error instanceof AppError) {
    return {
      error: error.message,
      code: error.code,
      feature: error.feature,
      action: error.action
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: `${fallback.messagePrefix || ''}${message}`,
    code: fallback.code,
    feature: fallback.feature,
    action: fallback.action
  };
}

export function formatAppError(error: unknown): string {
  if (error instanceof AppError) return `${error.message} Next step: ${error.action}`;
  return error instanceof Error ? error.message : String(error);
}

export function readAppError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const payload = data as Record<string, unknown>;
  const message = typeof payload.error === 'string' ? payload.error : fallback;
  return typeof payload.action === 'string' ? `${message} Next step: ${payload.action}` : message;
}
