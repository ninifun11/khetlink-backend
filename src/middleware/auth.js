import { supabase } from '../config/supabase.js';
import { HttpError, asyncHandler } from '../utils/http.js';

/**
 * Verifies the Supabase access token sent by the frontend
 * (Authorization: Bearer <jwt>) and attaches the user's profile as req.user.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, 'Sign in required');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Session expired — please sign in again');

  const { data: profile, error: pErr } = await supabase
    .from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (pErr) throw new HttpError(500, pErr.message);
  if (!profile) throw new HttpError(403, 'Profile not found for this account');

  req.user = { ...profile, email: data.user.email };
  next();
});

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, `This action is limited to: ${roles.join(', ')}`));
  }
  next();
};
