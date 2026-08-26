import express from 'express';
import { requireSuperAdmin } from '../middleware/auth';
import * as superadminController from '../controllers/superadmin';

const router = express.Router();

// Middleware guard for all Superadmin routes
router.use(requireSuperAdmin);

// Platform Stats
router.get('/stats', superadminController.getStats);

// Branch / Tenant Operations
router.get('/branches', superadminController.getBranches);
router.get('/branches/export.csv', superadminController.exportBranchesCsv);
router.get('/branches/export.pdf', superadminController.exportBranchesPdf);
router.get('/branches/:id', superadminController.getBranchById);
router.put('/branches/:id', superadminController.updateBranch);
router.delete('/branches/:id', superadminController.deleteBranch);
router.post('/branches', superadminController.createBranch);

// Academic Sessions
router.get('/sessions', superadminController.getSessions);
router.post('/sessions', superadminController.createSession);
router.put('/sessions/active', superadminController.setActiveSession);

// Subscriptions & Billing
router.get('/subscriptions', superadminController.getSubscriptions);
router.post('/branches/:id/renew-subscription', superadminController.renewSubscription);
router.post('/branches/:id/extend-subscription', superadminController.extendSubscription);

// Platform Revenue Analytics
router.get('/analytics', superadminController.getAnalytics);
router.get('/revenue-analytics', superadminController.getRevenueAnalytics);
router.get('/revenue-analytics/export/csv', superadminController.exportRevenueCsv);
router.get('/revenue-analytics/export/pdf', superadminController.exportRevenuePdf);

// Landing Pages CMS
router.get('/branches/:branchId/landing-page', superadminController.getBranchLandingPage);
router.put('/branches/:branchId/landing-page', superadminController.updateBranchLandingPage);
router.post('/branches/:branchId/landing-page/upload-media', superadminController.uploadLandingPageMedia);

// Domain Management
router.get('/domains', superadminController.getDomains);
router.post('/domains/:branchId/force-activate', superadminController.forceActivateDomain);
router.post('/domains/:branchId/verify-dns', superadminController.verifyBranchDomainDns);

export default router;
