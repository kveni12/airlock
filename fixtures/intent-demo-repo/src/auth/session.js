export function isSessionValid(session, now = Date.now()) {
  // BUG: expired sessions are treated as valid because expiry is never checked.
  return Boolean(session && session.userId);
}
