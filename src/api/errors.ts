export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** ST may wrap an upstream failure in HTTP 200; preserve its original status. */
export function responseError(value: unknown, fallbackStatus?: number): ApiError {
  const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = typeof value === 'string' ? value
    : typeof error.message === 'string' ? error.message : '副 API 返回错误';
  const supplied = error.status;
  const legacyStatus = message.trim() === 'Conflict' ? 409 : message.trim() === 'Gone' ? 410 : undefined;
  const status = typeof supplied === 'number' && Number.isInteger(supplied) && supplied >= 400 && supplied <= 599
    ? supplied : fallbackStatus ?? legacyStatus;
  return new ApiError(message, status, typeof error.code === 'string' ? error.code : undefined);
}
