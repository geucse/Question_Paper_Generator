import 'dotenv/config';
import express from 'express';
import 'express-async-errors'; // lets async route handlers `throw`/reject and still hit the error handler below, instead of hanging the request or crashing the process
import cors from 'cors';
import { pool } from './db.js';
import healthRoutes from './routes/health.js';
import { verifyTotpKeyCheck, rotationRequested } from './totp-key-check.js';
import userRoutes from './routes/users.js';
import authRoutes from './routes/auth.js';
import questionRoutes from './routes/questions.js';
import attachmentRoutes from './routes/attachments.js';
import bulkRoutes from './routes/bulk.js';
import paperRoutes from './routes/papers.js';
import reviewRoutes from './routes/review.js';
import reviewBatchRoutes from './routes/review-batches.js';
import aiReviewRoutes from './routes/ai-review.js';
import academicRoutes from './routes/academic.js';
import syllabusChangeRoutes from './routes/syllabus-changes.js';
import syllabusUploadRoutes from './routes/syllabus-upload.js';
import notificationRoutes from './routes/notifications.js';
import examinationRoutes from './routes/examinations.js';
import coeApprovalRoutes from './routes/coe-approval.js';
import questionsLifecycleRoutes from './routes/questions-lifecycle.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import {
  securityHeaders, createRateLimiters,
  checkBlocklist, flagSuspicious, AUTH_LIMITED_PATHS
} from './security.js';
import { productionConfigProblems, parseAllowedOrigins, parseTrustProxy, isProduction } from './runtime-config.js';
import { assertOtpDeliveryConfig, devSecretsExposed } from './otp-delivery.js';
import { loadTotpKey, totpKeyProblems } from './secret-box.js';
import { requestId, errorHandler, describeError } from './errors.js';
import { startAttachmentRescanSweeper, ensureUploadDirs } from './attachment-scan.js';
import { closeRateLimitStore } from './redis.js';

// CORS: production refuses to start without CORS_ALLOWED_ORIGINS (runtime-config.js). A disallowed Origin gets
// no CORS headers (the browser blocks the response) rather than an error that would become a 500. No request uses
// cookies (the JWT travels in the Authorization header, frontend/src/api.js), so `credentials` is not set and
// there is no CSRF exposure; if that ever changes, the allowlist becomes mandatory everywhere.
function buildCorsOptions() {
  const configured = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  if (configured.length === 0) {
    if (isProduction()) throw new Error('CORS_ALLOWED_ORIGINS is required in production');
    console.warn('[cors] CORS_ALLOWED_ORIGINS is not set: allowing every origin (development only).');
    return {};
  }
  return {
    origin(origin, callback) {
      // No Origin header at all (server-to-server calls, curl, health checks): allow.
      if (!origin || configured.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  };
}

// Startup checks in one place. Production refuses to start on any configuration problem (each message names the
// variable, never its value); development only warns, and keeps working with explicit dev-only settings.
function startupChecks() {
  const problems = productionConfigProblems();
  if (problems.length) throw new Error('Refusing to start in production:\n  - ' + problems.join('\n  - '));
  assertOtpDeliveryConfig();
  const keyProblems = totpKeyProblems();
  if (keyProblems.length) throw new Error(keyProblems.join('; '));
  loadTotpKey(); // warms the key (and the development-key warning)
  if (devSecretsExposed()) console.warn('[accounts] DEV_EXPOSE_ACCOUNT_SETUP_TOKEN is on: account setup codes are returned in API responses (development only).');
}

// The running TOTP key against the key check stored in the database (totp-key-check.js). A mismatch refuses to start
// in production; a database that is down at startup only defers the check (readiness and step-up retry it).
async function checkTotpKeyAtStartup() {
  let result;
  try {
    result = await Promise.race([verifyTotpKeyCheck(), new Promise((_, r) => setTimeout(() => r(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 5000).unref())]);
  } catch (e) {
    console.warn(`[totp] key check deferred until the database is reachable (${e?.code || e?.name || 'error'})`);
    return;
  }
  if (result === 'mismatch') {
    const msg = 'TOTP_ENCRYPTION_KEY does not match the key check stored in the database (system_state.totp_key_check), so stored authenticator secrets cannot be opened. '
      + 'Restore the previous key, or set TOTP_KEY_ROTATE=yes for one start to rotate it (every authenticator must then be set up again).';
    if (isProduction()) throw new Error(`Refusing to start in production: ${msg}`);
    console.warn(`[totp] ${msg} Authenticator step-up and enrolment are refused until this is fixed.`);
  } else if (result === 'initialised') {
    console.log('[totp] key check recorded for the current authenticator key.');
  } else if (rotationRequested() && result !== 'rotated') {
    console.warn('[totp] TOTP_KEY_ROTATE=yes is set but the key already matches; remove the setting.');
  }
}

async function main() {
  startupChecks();
  await checkTotpKeyAtStartup();
  ensureUploadDirs();
  const { globalLimiter, authLimiter } = await createRateLimiters();

  const app = express();

  // req.ip behind proxies: TRUST_PROXY is the number of proxy hops in front of this process (default 1; 2 for
  // k8s ingress-nginx -> frontend nginx). Rate limits, auto-blocking and lockdown all key on req.ip.
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

  app.use(requestId);
  app.use(securityHeaders);
  app.use('/api/health', healthRoutes);
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' })); // cap body size — cheap DoS mitigation
  app.use(checkBlocklist);
  app.use(globalLimiter);

  // Request logging. SECURITY: never the body or the query string (passwords, OTPs, tokens).
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.id} ${req.method} ${req.path}`);
    next();
  });

  // Strict per-IP limit on every path that takes a password or a code (security.js AUTH_LIMITED_PATHS).
  for (const p of AUTH_LIMITED_PATHS) app.use(p, authLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/questions', questionRoutes);
  app.use('/api/questions', questionsLifecycleRoutes);
  app.use('/api/attachments', attachmentRoutes);
  app.use('/api/bulk-upload', bulkRoutes);
  app.use('/api/papers', paperRoutes);
  app.use('/api/review', reviewRoutes);
  app.use('/api/review', reviewBatchRoutes);
  app.use('/api/ai-review', aiReviewRoutes);
  app.use('/api/academic/users', userRoutes); // account provisioning (routes/users.js), before the academic router
  app.use('/api/academic', academicRoutes);
  app.use('/api/academic', syllabusUploadRoutes); // HOD syllabus PDF upload + extraction (routes/syllabus-upload.js)
  app.use('/api/academic', syllabusChangeRoutes); // syllabus copy-forward, trees, change reports, question mapping (042)
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/examinations', examinationRoutes);
  app.use('/api/coe', coeApprovalRoutes);

  // PIVOT_SPEC_V2 section 31 namespaces. Old paths stay as compatibility aliases
  // until the frontend has fully migrated.
  app.use('/api/admin', adminRoutes);
  app.use('/api/question-bank', analyticsRoutes);
  app.use('/api/question-bank', questionRoutes);
  app.use('/api/question-bank', questionsLifecycleRoutes);
  app.use('/api/question-bank/bulk-upload', bulkRoutes);
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/reviews', reviewBatchRoutes);
  app.use('/api/validators', examinationRoutes);

  // Anything else is either a typo or reconnaissance/scanning — track it.
  app.use(async (req, res) => {
    await flagSuspicious(req, 'not_found_scan', { path: req.path, method: req.method });
    res.status(404).json({ error: 'Not found' });
  });

  // Centralized error handler (errors.js): generic message + request id to the client, one redacted JSON line
  // to the log (never pg's row details, parameters or bodies).
  app.use(errorHandler);

  const PORT = process.env.PORT || 4000;
  const server = app.listen(PORT, () => console.log(`Exam portal API running on http://localhost:${PORT}`));
  const sweeper = startAttachmentRescanSweeper();

  // Graceful shutdown: stop accepting new connections, let in-flight
  // requests finish, then close the DB pool — so a container orchestrator's
  // SIGTERM (rolling deploy, scale-down) doesn't cut off a request
  // mid-write the way an abrupt process.exit() would.
  async function shutdown(signal) {
    console.log(`${signal} received, shutting down gracefully...`);
    sweeper.stop();
    server.close(async () => {
      try { await closeRateLimitStore(); } catch { /* already closed */ }
      try { await pool.end(); } catch { /* already closed or unreachable — fine on shutdown */ }
      process.exit(0);
    });
    // Don't hang forever waiting for stubborn connections to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', JSON.stringify(describeError(e))));

main().catch((err) => {
  console.error('Fatal error during server startup:', err?.message || err);
  process.exit(1);
});
