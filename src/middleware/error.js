import { HttpError } from '../utils/http.js';

export function notFound(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(status).json({
    error: status >= 500 && process.env.NODE_ENV === 'production' && status === 500 ? 'Something went wrong on our side' : err.message,
    ...(err.details && status < 500 ? { details: err.details } : {}),
  });
}
