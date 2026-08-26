import express from 'express';
import * as authController from '../controllers/auth';

const router = express.Router();

// Public Authentication & Onboarding Routes
router.post('/login', authController.login);
router.post('/register', authController.register);
router.get('/me', authController.getMe);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-token', authController.verifyResetToken);
router.post('/reset-password', authController.resetPassword);

export default router;
