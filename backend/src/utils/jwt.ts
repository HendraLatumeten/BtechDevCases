import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { AppConfig } from '../config.js';

export interface AuthTokenClaims {
  sub: string;
  userId: string;
  email: string;
  jti: string;
  iat?: number;
  exp?: number;
}

export function signAuthToken(
  payload: { userId: string; email: string; sessionId: string },
  config: Pick<AppConfig, 'jwtSecret' | 'jwtExpiresIn'>
): string {
  const options: SignOptions = {
    expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'],
    subject: payload.userId,
    jwtid: payload.sessionId,
  };

  return jwt.sign(
    {
      userId: payload.userId,
      email: payload.email,
    },
    config.jwtSecret,
    options
  );
}

export function verifyAuthToken(
  token: string,
  config: Pick<AppConfig, 'jwtSecret'>
): AuthTokenClaims {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Invalid token payload');
  }

  const userId = typeof decoded.userId === 'string' ? decoded.userId : decoded.sub;
  const email = typeof decoded.email === 'string' ? decoded.email : '';
  const jti = typeof decoded.jti === 'string' ? decoded.jti : '';

  if (!userId || !email || !jti) {
    throw new Error('Missing required token claims');
  }

  return {
    sub: userId,
    userId,
    email,
    jti,
    iat: decoded.iat,
    exp: decoded.exp,
  };
}

