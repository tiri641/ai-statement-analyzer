const ALLOWED_LOG_FIELDS = new Set([
  "event",
  "requestId",
  "statementId",
  "messageId",
  "status",
  "durationMs",
  "receiveCount",
  "errorCode",
  "stage",
  "disposition",
  "modelId",
  "promptVersion",
  "method",
  "route",
  "httpStatus",
  "signal",
  "cached",
  "host",
  "port",
  "transactionCount",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "targetMonth",
]);

const MAX_LOG_STRING_LENGTH = 512;

export interface StructuredLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface StructuredLoggerOptions {
  service: string;
  now?: () => Date;
  writeInfo?: (line: string) => void;
  writeError?: (line: string) => void;
}

function sanitizeString(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_LOG_STRING_LENGTH);
}

function sanitizeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return undefined;
}

function createLine(
  service: string,
  now: () => Date,
  fields: Record<string, unknown>,
): string {
  const output: Record<string, string | number | boolean> = {
    event: "unknown",
    timestamp: now().toISOString(),
    service: sanitizeString(service),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_LOG_FIELDS.has(key)) {
      continue;
    }

    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }

  if (typeof fields.event === "string" && fields.event.length > 0) {
    output.event = sanitizeString(fields.event);
  }

  return JSON.stringify(output);
}

export function createStructuredLogger(
  options: StructuredLoggerOptions,
): StructuredLogger {
  const now = options.now ?? (() => new Date());
  const writeInfo = options.writeInfo ?? ((line) => console.log(line));
  const writeError = options.writeError ?? ((line) => console.error(line));

  return {
    info: (fields) => writeInfo(createLine(options.service, now, fields)),
    error: (fields) => writeError(createLine(options.service, now, fields)),
  };
}
