import { Router } from 'express';
import multer from 'multer';
import { objectController } from '../controller/object.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
});

const router = Router();

// Binding controllers maintains 'this' context inside controller functions
router.post('/upload', upload.single('file'), objectController.upload.bind(objectController));
router.get('/objects/:id', objectController.download.bind(objectController));
router.get('/objects', objectController.list.bind(objectController));
router.delete('/objects/:id', objectController.delete.bind(objectController));

export default router;
