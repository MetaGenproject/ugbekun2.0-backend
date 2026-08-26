import express from 'express';
import { requireParent } from '../middleware/auth';
import * as parentController from '../controllers/parent';

const router = express.Router();

// Middleware guard for all Parent routes
router.use(requireParent);

// Children Roster
router.get('/children', parentController.getChildren);

// Child Specific Academic & Attendance Views
router.get('/child/:studentId/profile', parentController.assertChildLinked, parentController.getChildProfile);
router.get('/child/:studentId/attendance', parentController.assertChildLinked, parentController.getChildAttendance);
router.get('/child/:studentId/tasks', parentController.assertChildLinked, parentController.getChildTasks);
router.get('/child/:studentId/grades', parentController.assertChildLinked, parentController.getChildGrades);
router.get('/child/:studentId/export-pdf', parentController.assertChildLinked, parentController.exportChildReportPdf);
router.get('/child/:studentId/invoices', parentController.assertChildLinked, parentController.getChildInvoices);
router.get('/child/:studentId/timetable', parentController.assertChildLinked, parentController.getChildTimetable);
router.get('/child/:studentId/teachers', parentController.assertChildLinked, parentController.getChildTeachers);
router.post('/child/:studentId/upload-photo', parentController.assertChildLinked, parentController.uploadChildPhoto);

// Sibling Enrollment & Requests
router.get('/classes-sections', parentController.getClassesSections);
router.get('/sibling-requests', parentController.getSiblingRequests);
router.post('/sibling-requests', parentController.createSiblingRequest);

// School Events & Communication
router.get('/events', parentController.getEvents);
router.get('/messages', parentController.getMessages);
router.post('/messages', parentController.sendMessage);

// Parent Profile & Security
router.get('/profile', parentController.getProfile);
router.put('/profile', parentController.updateProfile);
router.post('/profile/upload-photo', parentController.uploadParentPhoto);
router.put('/change-password', parentController.changePassword);

export default router;
