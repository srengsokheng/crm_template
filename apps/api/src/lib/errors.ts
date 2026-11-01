export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>, details?: unknown) {
    super(message);
    this.status = status; this.code = code; this.fields = fields; this.details = details;
  }
}
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string, fields?: Record<string, string>) => new AppError(400, 'VALIDATION_FAILED', msg, fields);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
