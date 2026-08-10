import { Router } from 'express';
import {
  getDocumentAnalytics,
  getLinkAnalytics,
  trackView,
} from '../controllers/analytics.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

router.post('/track', trackView);
router.get('/document/:documentId', protect, getDocumentAnalytics);
router.get('/link/:linkId', protect, getLinkAnalytics);

export default router;
