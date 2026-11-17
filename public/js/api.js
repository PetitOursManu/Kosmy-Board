/* Appels à l'API du Board. Les erreurs remontent avec leur code (traduit par errorText). */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || "generic");
    this.status = status;
    this.code = body?.error || "generic";
    this.extra = body || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: "network" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === "auth") onUnauthorized();
    throw new ApiError(res.status, data.error ? data : { error: res.status >= 500 ? "server" : "generic" });
  }
  return data;
}

export const api = {
  get: (url) => request("GET", url),
  post: (url, body = {}) => request("POST", url, body),
  put: (url, body) => request("PUT", url, body),
  patch: (url, body) => request("PATCH", url, body),
  del: (url) => request("DELETE", url),
};
