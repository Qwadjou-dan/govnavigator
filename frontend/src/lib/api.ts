import type {
  AnswerContract,
  Category,
  Institution,
  QueryResponse,
  SavedChecklist,
  ServiceSummary,
  SystemInfo,
} from './types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api';

const TOKEN_KEY = 'gn.token';
const SESSION_KEY = 'gn.session';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — sign-in simply will not persist */
  }
}

/** A session id groups a person's questions for analytics. It is not identity. */
export function sessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, '');
      window.localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

/** "Start over": drop the session id so the next ask begins a fresh
 *  conversation. The old records stay in the server's audit trail; they just
 *  stop steering anything. */
export function resetSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private browsing — nothing was stored anyway */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** True when the failure means "you are not signed in any more", as opposed to
 *  "the server is unhappy". Screens branch on this to offer sign-in rather than
 *  an apology the person can do nothing about. */
export const isSignedOut = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;

/** On these two endpoints a 401 means "that code is wrong" — it is the normal
 *  failure of signing in, not the death of a session, so it must not clear a
 *  token. Everywhere else a 401 is terminal for the token we just sent. */
const SIGN_IN_ENDPOINTS = ['/auth/verify-code', '/auth/curator-login'];

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new ApiError(
      'We cannot reach the service right now. Check your connection, or go to the official institution page directly.',
      0,
    );
  }

  // Belt-and-suspenders offline support: write successful GET responses into
  // the same Cache Storage the service worker reads from (`gn-api-v1`).  On a
  // slow connection the SW may not have claimed the page yet when the first
  // API call fires, so the SW's own cache.put never runs.  Writing here
  // ensures the data is waiting in the cache when the person goes offline.
  if (res.ok && (!init.method || init.method === 'GET') && typeof caches !== 'undefined') {
    const cacheReq = new Request(`${BASE}${path}`);
    caches.open('gn-api-v1').then((c) => c.put(cacheReq, res.clone())).catch(() => {});
  }

  if (!res.ok) {
    let detail = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* keep the default */
    }

    // A 401 on a request that *carried* a token means that token is dead: the
    // session expired, JWT_SECRET was rotated, or the database was reseeded and
    // the user row it points at no longer exists. Whichever it is, the token can
    // never succeed again, so drop it here — at the one boundary every call
    // passes through. Leaving it in storage is what makes the failure look
    // permanent: every screen sees a token, assumes a session, and keeps
    // failing without ever offering to sign in.
    if (res.status === 401 && token && !SIGN_IN_ENDPOINTS.some((p) => path.startsWith(p))) {
      setToken(null);
      detail = 'Your session has ended. Sign in again to pick up where you left off.';
    }

    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

// --- the core loop ---------------------------------------------------------

export function ask(payload: {
  text: string;
  answers?: Record<string, string>;
  service_id?: string;
  skip_clarification?: boolean;
  /** Put this condition back to the person instead of inferring it again. */
  reopen?: string;
}): Promise<QueryResponse> {
  return request<QueryResponse>('/query', {
    method: 'POST',
    body: JSON.stringify({ ...payload, session_id: sessionId() }),
  });
}

export const getSystem = () => request<SystemInfo>('/system');
export const listServices = () => request<ServiceSummary[]>('/services');
export const listCategories = () => request<Category[]>('/categories');
export const getService = (id: string) => request<AnswerContract>(`/services/${id}`);
export const listInstitutions = () => request<Institution[]>('/institutions');
export const getInstitution = (id: string) =>
  request<{ institution: Institution; notes: string; services: ServiceSummary[] }>(
    `/institutions/${id}`,
  );

export const sendFeedback = (payload: {
  answer_id?: string | null;
  service_id?: string | null;
  verdict: 'yes' | 'partly' | 'no';
  comment?: string;
}) =>
  request<{ recorded: boolean; message: string }>('/feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

/** Log the "I need a real person" click into the curator backlog. */
export const requestEscalation = (payload: {
  query_text: string;
  service_id?: string | null;
  institution_id?: string | null;
  outcome: string;
}) =>
  request<{ recorded: boolean; message: string }>('/coverage/escalate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

// --- identity --------------------------------------------------------------

export const requestCode = (contact: string) =>
  request<{ sent: boolean; message: string; dev_code?: string }>('/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ contact }),
  });

export const verifyCode = (contact: string, code: string) =>
  request<{ access_token: string; role: string; label: string }>('/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ contact, code }),
  });

export const curatorLogin = (contact: string, code: string) =>
  request<{ access_token: string; role: string; label: string }>('/auth/curator-login', {
    method: 'POST',
    body: JSON.stringify({ contact, code }),
  });

export const me = () => request<{ id: string; role: string; label: string }>('/auth/me');

// --- checklists ------------------------------------------------------------

export const listChecklists = () => request<SavedChecklist[]>('/checklists');

export const saveChecklist = (payload: {
  service_id: string;
  title: string;
  payload?: Record<string, unknown>;
  progress?: Record<string, boolean>;
}) =>
  request<SavedChecklist>('/checklists', {
    method: 'POST',
    body: JSON.stringify({ payload: {}, progress: {}, ...payload }),
  });

export const deleteChecklist = (id: string) =>
  request<{ deleted: boolean }>(`/checklists/${id}`, { method: 'DELETE' });

// --- curator ---------------------------------------------------------------

export const adminOverview = () => request<any>('/admin/overview');
export const adminGaps = () => request<any[]>('/admin/coverage-gaps');
export const adminCorrections = () => request<any[]>('/admin/corrections');
export const adminRecent = () => request<any[]>('/admin/recent-queries');
export const adminVerify = (serviceId: string) =>
  request<any>(`/admin/services/${serviceId}/verify`, { method: 'POST' });
export const adminResolve = (id: string, resolution: string) =>
  request<any>(
    `/admin/corrections/${id}/resolve?resolution=${encodeURIComponent(resolution)}`,
    { method: 'POST' },
  );
