import type { Request, Response, NextFunction } from 'express';
import { objectService } from '../services/object.service.js';

export class ObjectController {
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const id = await objectService.upload(
        req.file.originalname,
        req.file.mimetype,
        req.file.buffer
      );

      res.status(201).json({ id });
    } catch (error) {
      next(error);
    }
  }

  async download(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      
      
      const { metadata, buffer } = await objectService.download(id);

      res.setHeader('Content-Type', metadata.mimeType);
      res.setHeader('Content-Length', metadata.size);
      res.setHeader('Content-Disposition', `attachment; filename="${metadata.fileName}"`);
      res.end(buffer);
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      

      await objectService.delete(id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const objects = await objectService.list();
      res.status(200).json(objects);
    } catch (error) {
      next(error);
    }
  }
}

export const objectController = new ObjectController();
