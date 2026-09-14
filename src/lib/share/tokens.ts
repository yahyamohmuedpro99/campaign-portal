import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/** 256 bits of randomness: the link itself is the first of the two things a stranger
 *  would have to get past, and it is not meant to be guessable. */
export function newShareToken() {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is stored, so a leaked database row cannot be turned back into a link. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function tokenHashHex(token: string): string {
  return `\\x${hashToken(token).toString('hex')}`;
}

export function constantTimeEquals(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

const alg = 'HS256';
function secret() {
  const s = process.env.SHARE_SESSION_SECRET;
  if (!s) throw new Error('SHARE_SESSION_SECRET is not set');
  return new TextEncoder().encode(s);
}

/** Issued only after the password is accepted, scoped to one share, and short-lived.
 *  Binding it to the share id means a cookie from one link cannot open another. */
export async function issueShareSession(shareId: string) {
  return new SignJWT({ share: shareId })
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(await secret());
}

export async function readShareSession(jwt: string | undefined, shareId: string) {
  if (!jwt) return false;
  try {
    const { payload } = await jwtVerify(jwt, await secret(), { algorithms: [alg] });
    return payload.share === shareId;
  } catch {
    return false;
  }
}

export const shareCookieName = (token: string) =>
  `share_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
