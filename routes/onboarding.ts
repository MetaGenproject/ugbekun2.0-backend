import express from 'express';
import * as onboardingController from '../controllers/onboarding';

const router = express.Router();

// Onboarding & School Self-Registration Routes
router.get('/plans', onboardingController.getPlans);
router.get('/plans/:slug/summary', onboardingController.getPlanSummary);
router.post('/register', onboardingController.registerSchool);

export default router;
