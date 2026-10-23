// Credential redaction for anything that may reach a log line (no imports, so every module can use it).

// Credentials inside URLs (postgres://user:pass@host, redis://:pass@host) -> scheme://***@host
export function redact(s) {
  return String(s ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

export function redactUrl(u) {
  try {
    const x = new URL(u);
    if (x.password) x.password = '***';
    if (x.username) x.username = '***';
    return x.toString();
  } catch {
    return '[unparseable url]';
  }
}
