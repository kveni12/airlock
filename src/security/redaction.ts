const SECRET_NAME_PATTERN = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
const KEY_VALUE_SECRET_PATTERN =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s"']+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PEM_PATTERN = /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g;

export interface RedactionContext {
  secretNames?: string[];
  secretValues?: string[];
}

export class Redactor {
  constructor(private readonly context: RedactionContext = {}) {}

  sanitize<T>(value: T): T {
    return sanitizeValue(value, this.context) as T;
  }
}

export function sanitizeValue(value: unknown, context: RedactionContext = {}): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, context));
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[key] = SECRET_NAME_PATTERN.test(key)
        ? sanitizeSecretField(nested)
        : sanitizeValue(nested, context);
    }
    return sanitized;
  }

  return value;
}

function sanitizeSecretField(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretField(item));
  }
  if (value && typeof value === "object") {
    return "[REDACTED]";
  }
  return value === undefined || value === null || value === "" ? value : "[REDACTED]";
}

function sanitizeString(input: string, context: RedactionContext): string {
  let output = input;

  for (const secretValue of context.secretValues ?? []) {
    if (secretValue) {
      output = output.split(secretValue).join("[REDACTED]");
    }
  }

  output = output.replace(PEM_PATTERN, "[REDACTED]");
  output = output.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  output = output.replace(KEY_VALUE_SECRET_PATTERN, "$1=[REDACTED]");

  for (const secretName of context.secretNames ?? []) {
    const assignment = new RegExp(`(${escapeRegExp(secretName)}\\s*=\\s*)([^\\s"']+)`, "gi");
    output = output.replace(assignment, "$1[REDACTED]");
  }

  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
