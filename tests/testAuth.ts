import type { FastifyInstance } from "fastify";
import type { AuthService } from "../src/auth/authService.js";

export const TEST_OPERATOR = { email: "operator@example.com", password: "test-operator-password" };

/** Bootstraps the first admin and returns the session cookie header tests must send with every request. */
export async function signIn(app: FastifyInstance, auth: AuthService): Promise<string> {
  const setupToken = await auth.issueSetupToken();
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    payload: { ...TEST_OPERATOR, displayName: "Test Operator", setupToken }
  });
  if (response.statusCode !== 201) throw new Error(`Bootstrap failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find((item) => item.name === "periscope_session");
  if (!cookie) throw new Error("Bootstrap did not set a session cookie");
  return `${cookie.name}=${cookie.value}`;
}
