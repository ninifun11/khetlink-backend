import { HttpError } from '../utils/http.js';

/**
 * validate(zodSchema, 'body' | 'query' | 'params')
 * Parsed body/params replace req.body/req.params; parsed query is exposed as req.q
 */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const first = details[0];
    return next(new HttpError(400, first ? `${first.field || 'input'}: ${first.message}` : 'Invalid input', details));
  }
  if (source === 'query') req.q = result.data;
  else req[source] = result.data;
  next();
};
