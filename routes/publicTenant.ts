import express from 'express';
import * as publicTenantController from '../controllers/publicTenant';

const router = express.Router();

// Public School CMS & Domain Resolution Routes
router.get('/homepage', publicTenantController.getHomepage);
router.get('/branding', publicTenantController.getBranding);
router.get('/schools', publicTenantController.listPublicSchools);
router.get('/school-info', publicTenantController.getPublicSchoolInfo);
router.get('/resolve-domain', publicTenantController.resolveDomain);

// Public Online Admissions Routes
router.get('/admissions/meta', publicTenantController.getAdmissionMetadata);
router.post('/admissions/apply', publicTenantController.submitAdmissionApplication);

export default router;
