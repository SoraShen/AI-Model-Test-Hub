import dotenv from 'dotenv';

// Load local dev env first, then fallback to .env
dotenv.config({ path: '.env.local', override: true });
dotenv.config();

