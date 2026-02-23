// api/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function entry point.
//
// Vercel routes all requests here via vercel.json.
// We simply re-export the Express app from src/server.ts so there is a single
// source of truth — no duplication, no drift.
//
// Vercel calls the exported handler for every request.
// app.listen() is never called here; Vercel manages the server lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

export { default } from '../src/server.js';
