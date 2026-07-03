import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import objectRouter from './routes/object.route.js';

const app = express();

app.use(express.json());

// Routes
app.use(objectRouter);

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  res.status(statusCode).json({ error: message });
});

export default app;
