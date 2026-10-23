// Local dev (vite dev server, no reverse proxy) defaults to hitting the
// backend directly on :4000 — unchanged from before. Production Docker
// builds set VITE_API_BASE_URL=/api at build time (see frontend/Dockerfile
// and docker-compose.prod.yml), and nginx.conf proxies /api/* to the
// backend container, so the browser only ever talks to one origin.
const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

async function request(method, path, body, token, isForm) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.blob();

  if (!res.ok) {
    // session_invalid is set only by requireAuth itself (missing/expired/
    // revoked token) — never by a route's own business-logic 401 (wrong
    // current password, wrong TOTP code, etc), so this can't misfire and
    // log someone out over a typo. See middleware.js for the other side.
    // Only when the refused token is still the signed-in one: a request that was in flight with a token replaced
    // meanwhile (password change issues a new one) must not sign the user out of the new session.
    if (data?.session_invalid && token && localStorage.getItem('portal_token') === token) {
      localStorage.removeItem('portal_token');
      window.location.reload();
    }
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path, token) => request('GET', path, null, token),
  post: (path, body, token) => request('POST', path, body, token),
  patch: (path, body, token) => request('PATCH', path, body, token),
  put: (path, body, token) => request('PUT', path, body, token),
  del: (path, token) => request('DELETE', path, null, token),
  // multipart upload (FormData): the browser sets the boundary header itself
  upload: (path, form, token) => request('POST', path, form, token, true),
  // a binary response (e.g. a PDF) as a Blob
  blob: (path, token) => request('GET', path, null, token),
  postForm: (path, formData, token) => request('POST', path, formData, token, true),
  fileUrl: (attachmentId) => `${BASE}/attachments/${attachmentId}/file`,
  // Authenticated download (the token can't go in a plain <a href>): fetch as a blob and save it.
  download: async (path, token, filename) => {
    const blob = await request('GET', path, null, token);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
