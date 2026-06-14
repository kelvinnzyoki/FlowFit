// Put this in src/server.ts BEFORE app.use(express.json()).
// Paystack signs the exact raw request bytes; express.json() changes req.body
// into an object and breaks signature verification.

import express from 'express';
import paystackWebhookRoutes from './routes/paystack.webhook.routes';

app.use(
  '/api/v1/webhooks',
  express.raw({ type: 'application/json' }),
  paystackWebhookRoutes,
);

// Only after the Paystack webhook raw-body mount:
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
