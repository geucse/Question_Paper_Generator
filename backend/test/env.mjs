// Must be imported before any src/ module (imports are hoisted).
// Values set here win over backend/.env (dotenv never overrides a variable that is already set), so every key the
// tests depend on is set explicitly, to '' where it must be off.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
process.env.DATABASE_URL = 'postgres://fake:fake@127.0.0.1:1/fake';
process.env.APP_DATABASE_URL = '';
process.env.PORT = String(4600 + (process.pid % 300)); // each test file runs in its own process
process.env.AUTH_RATE_MAX = '1000';
process.env.GLOBAL_RATE_MAX = '100000'; // the IDOR matrices issue thousands of requests from one address
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_STORE = 'memory'; // no Redis connection in tests
process.env.READINESS_CACHE_MS = '0';
process.env.ATTACHMENT_RESCAN_INTERVAL_MS = '0';
process.env.CLAMD_HOST = ''; // tests that need a scanner start a fake clamd and set these themselves
process.env.CLAMD_SOCKET = '';
process.env.CLAMD_PORT = '';
process.env.CORS_ALLOWED_ORIGINS = '';
// Code delivery: SMTP with an injected transport (harness.mjs setTransportForTests); never the console.
process.env.OTP_DELIVERY_PROVIDER = 'smtp';
process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'u';
process.env.SMTP_PASS = 'p';
process.env.SMTP_FROM = 'noreply@t.edu';
process.env.SMTP_SECURE = 'false';
process.env.DEV_OTP_CONSOLE = '';
process.env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN = 'false';
process.env.TOTP_ENCRYPTION_KEY = '11'.repeat(32);
delete process.env.ANTHROPIC_API_KEY; // route tests use the deterministic heuristic reviewer, never the network
process.env.ANTHROPIC_API_KEY = '';
