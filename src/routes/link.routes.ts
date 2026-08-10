import { Router } from 'express';
import {
  createShareLink,
  getDocumentLinks,
  getLinkBySlug,
  updateShareLink,
  deleteShareLink,
} from '../controllers/link.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

router.get('/slug/:slug', getLinkBySlug);
router.post('/', protect, createShareLink);
router.get('/document/:documentId', protect, getDocumentLinks);
router.put('/:id', protect, updateShareLink);
router.delete('/:id', protect, deleteShareLink);

export default router;
