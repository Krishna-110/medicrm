const TOKEN_KEY = 'medcrm_token';
const FLASH_KEY = 'medcrm_flash';

/**
 * Where the API lives.
 *
 * Unset — as in development — this is '/api', same-origin, which Vite proxies to the local
 * server. In production the API answers on its own domain, so VITE_API_URL names it and the
 * value is baked into the bundle at build time. Set it to the host alone
 * (https://api.example.com); the '/api' prefix is added here so the variable does not have to
 * carry a path, and a trailing slash is tolerated rather than producing '//api'.
 */
const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/+$/, '')}/api`
  : '/api';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Set right before navigating to /login on session expiry; Login.tsx shows it once
// the new page has mounted (a toast fired an instant before a full navigation would
// never actually render).
export function takeFlashMessage(): string | null {
  const message = sessionStorage.getItem(FLASH_KEY);
  if (message) sessionStorage.removeItem(FLASH_KEY);
  return message;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'Unable to reach the server. Check your connection and try again.');
  }

  // /auth/login's own 401 means "wrong email or password" and carries a specific
  // message from the backend — only every OTHER endpoint's 401 means "this session is
  // no longer valid," which is the one case that should force a re-login.
  if (res.status === 401 && path !== '/auth/login') {
    clearToken();
    if (!window.location.pathname.startsWith('/login')) {
      sessionStorage.setItem(FLASH_KEY, 'Your session has expired. Please log in again.');
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Unauthorized');
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? 'Request failed');
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
