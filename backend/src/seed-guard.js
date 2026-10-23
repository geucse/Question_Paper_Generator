// Imported by seed.js right after dotenv, before anything touches the database. The seed creates demo accounts
// whose passwords are published in this repository, so it never runs against a production deployment; there is
// deliberately no override (provision real accounts through the admin UI, which emails one-time setup codes).
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV=production. seed.js creates demo accounts whose passwords are published in this repository; '
    + 'create real accounts through the admin UI (Accounts) instead.');
  process.exit(1);
}
