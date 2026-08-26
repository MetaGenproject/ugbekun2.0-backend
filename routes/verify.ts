import express from 'express';
import * as verifyController from '../controllers/verify';

const router = express.Router();

// Public Credential Verification
router.get('/:token', verifyController.verifyToken);

export default router;
