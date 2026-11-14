import type { Express } from 'express';

export function registerApiNotFound(app: Express): void {
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });
}
