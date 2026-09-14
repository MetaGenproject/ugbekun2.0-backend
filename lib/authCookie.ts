import { Request, Response } from 'express';

export const AUTH_COOKIE_NAME = 'ugbekun_token';
export const AUTH_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
  });
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

export function getAccessToken(req: Request): string | null {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  const fromCookie = readCookie(req, AUTH_COOKIE_NAME);
  return fromCookie && fromCookie.trim() ? fromCookie.trim() : null;
}
