import { Router } from 'express';
import { upload, uploadDocument, getUserDocuments } from '../controllers/document.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

router.use(protect);
router.get('/', getUserDocuments);
router.post('/upload', upload.single('file'), uploadDocument);

export default router;
