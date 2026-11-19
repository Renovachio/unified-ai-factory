/** RFC 9457 Problem Details (`application/problem+json`). Never includes stack traces or internal identifiers. */
export interface ProblemInit {
  status: number;
  code: string;
  title: string;
  detail?: string;
  headers?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export class ApiProblem extends Error {
  constructor(readonly init: ProblemInit) {
    super(init.detail ?? init.title);
    this.name = "ApiProblem";
  }
}

export const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } as const;

export function problemResponse(p: ProblemInit, instance?: string): Response {
  return new Response(
    JSON.stringify({ type: `https://factory.invalid/problems/${p.code}`, title: p.title, status: p.status, ...(p.detail ? { detail: p.detail } : {}), ...(instance ? { instance } : {}), ...(p.extra ?? {}) }),
    { status: p.status, headers: { "content-type": "application/problem+json", ...SECURITY_HEADERS, ...(p.headers ?? {}) } },
  );
}

export const problems = {
  badRequest: (detail: string, extra?: Record<string, unknown>) => new ApiProblem({ status: 400, code: "bad-request", title: "Bad Request", detail, ...(extra ? { extra } : {}) }),
  unauthorized: (detail = "Authentication required") => new ApiProblem({ status: 401, code: "unauthorized", title: "Unauthorized", detail, headers: { "www-authenticate": 'Bearer realm="factory"' } }),
  forbidden: (detail = "Insufficient permissions") => new ApiProblem({ status: 403, code: "forbidden", title: "Forbidden", detail }),
  notFound: (detail = "Resource not found") => new ApiProblem({ status: 404, code: "not-found", title: "Not Found", detail }),
  methodNotAllowed: (allow: string[]) => new ApiProblem({ status: 405, code: "method-not-allowed", title: "Method Not Allowed", headers: { allow: allow.join(", ") } }),
  conflict: (code: string, detail: string) => new ApiProblem({ status: 409, code, title: "Conflict", detail }),
  tooLarge: (limit: number) => new ApiProblem({ status: 413, code: "payload-too-large", title: "Payload Too Large", detail: `request body exceeds ${limit} bytes` }),
  unsupportedMedia: () => new ApiProblem({ status: 415, code: "unsupported-media-type", title: "Unsupported Media Type", detail: "Content-Type must be application/json" }),
  unprocessable: (detail: string, errors?: string[]) => new ApiProblem({ status: 422, code: "validation-failed", title: "Unprocessable Content", detail, ...(errors ? { extra: { errors } } : {}) }),
  rateLimited: (retryAfterSec: number) => new ApiProblem({ status: 429, code: "rate-limited", title: "Too Many Requests", headers: { "retry-after": String(retryAfterSec) } }),
  preconditionRequired: (detail: string) => new ApiProblem({ status: 428, code: "precondition-required", title: "Precondition Required", detail }),
};
