import { isSessionValid } from "../../src/auth/session.js";

if (!isSessionValid({ userId: "u1", expiresAt: Date.now() + 60_000 })) {
  throw new Error("active session should be valid");
}
console.log("session tests passed");
