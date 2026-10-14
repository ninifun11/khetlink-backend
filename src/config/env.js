import 'dotenv/config';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((k) => !process.env[k] || process.env[k].includes('YOUR'));
if (missing.length) {
  console.error(`\n✖ Missing environment variables: ${missing.join(', ')}\n  Copy backend/.env.example to backend/.env and fill in your Supabase keys.\n`);
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  aiUrl: (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, ''),
  aiKey: process.env.AI_SERVICE_KEY || '',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
};
