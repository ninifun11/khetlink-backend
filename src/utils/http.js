export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Wrap async route handlers so rejected promises reach the error middleware
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Return `data` from a Supabase { data, error } result or throw an HttpError
export function unwrap({ data, error }, status = 500) {
  if (error) throw new HttpError(status, error.message, error.details);
  return data;
}
