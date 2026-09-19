import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordHash {
  salt: string;
  passwordHash: string;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return { salt, passwordHash: derived.toString("hex") };
}

export async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(hash.passwordHash, "hex");
  const derived = await scrypt(password, hash.salt, expected.length || KEY_LENGTH);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function assertUsablePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return password;
}

export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    throw new Error("A valid email address is required");
  }
  return email.trim().toLowerCase();
}
