// api/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless function entry point.
// Place this file at: <project-root>/api/index.ts  (NOT inside src/)
//
// Vercel automatically treats every file inside /api as a serverless function.
// The rewrite in vercel.json sends ALL incoming requests here, and Vercel
// invokes the exported Express app as a handler for each request.
// ─────────────────────────────────────────────────────────────────────────────

import app from '../src/server.js';

export default app;
