import { config } from 'dotenv';

// Load .env.local (developer machine) then .env, without clobbering values
// that are already exported into the environment (CI).
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

process.env.TZ ??= 'UTC';
