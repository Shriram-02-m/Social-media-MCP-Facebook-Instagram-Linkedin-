export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  accessToken?: string;
};

function cleanMessage(input: string): string {
  return input
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(client_secret|refresh_token|authorization_code)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 700);
}

export async function apiRequest<T>(input: string | URL, options: RequestOptions = {}) {
  const { accessToken, headers = {}, ...requestOptions } = options;
  const response = await fetch(input, {
    ...requestOptions,
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...headers },
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { message: raw || response.statusText };
  }
  if (!response.ok) {
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const errorBody = body["error"];
    const nested = errorBody && typeof errorBody === "object" ? errorBody as Record<string, unknown> : body;
    const message = cleanMessage(String(nested["message"] ?? nested["error_description"] ?? response.statusText));
    const code = nested["code"] ?? nested["type"] ?? nested["error"];
    throw new ApiError(message, response.status, code === undefined ? undefined : String(code));
  }
  return { data: parsed as T, response };
}

export function explainError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return `Authentication failed or the token has expired: ${error.message}`;
    if (error.status === 403) return `The token is missing a required permission or account role: ${error.message}`;
    if (error.status === 429) return `The platform rate limit was reached: ${error.message}`;
    return `Platform API returned HTTP ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "An unknown error occurred.";
}