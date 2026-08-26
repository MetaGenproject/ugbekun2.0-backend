import express from 'express';
import { requireStudent } from '../middleware/auth';
import * as studentController from '../controllers/student';

const router = express.Router();

// Middleware guard for all Student routes
router.use(requireStudent);

// Dashboard Overview & Profile
router.get('/dashboard-overview', studentController.getDashboardOverview);
router.get('/profile', studentController.getProfile);
router.get('/attendance', studentController.getAttendance);
router.get('/tasks', studentController.getTasks);
router.get('/grades', studentController.getGrades);
router.get('/grades/export-pdf', studentController.exportGradesPdf);

// Homework Submission
router.post('/homeworks/:id/submit', studentController.submitHomework);

// CBT / Online Exams
router.get('/cbt/active-exams', studentController.getActiveCbtExams);
router.get('/cbt/exams/:id/take', studentController.takeCbtExam);
router.post('/cbt/exams/:id/submit', studentController.submitCbtExam);
router.post('/online-exams/:id/start', studentController.takeCbtExam);
router.post('/online-exams/:id/submit', studentController.submitCbtExam);

// Media & Virtual Classrooms
router.get('/media', studentController.getMedia);
router.get('/live-rooms', studentController.getLiveRooms);
router.get('/live-rooms/:roomName/token', studentController.getLiveRoomToken);

// Trivia & Gamification
router.get('/trivia/active', studentController.getActiveTrivia);
router.post('/trivia/submit', studentController.submitTrivia);
router.get('/gamification/profile', studentController.getGamificationProfile);
router.get('/gamification/leaderboard', studentController.getGamificationLeaderboard);

// Campus Events, Teachers & Invoices
router.get('/events', studentController.getEvents);
router.get('/teachers', studentController.getTeachers);
router.get('/invoices', studentController.getInvoices);
router.get('/timetable', studentController.getTimetable);

// Study Reminders
router.get('/reminders', studentController.getReminders);
router.post('/reminders', studentController.createReminder);
router.put('/reminders/:id/toggle', studentController.toggleReminder);
router.delete('/reminders/:id', studentController.deleteReminder);

// Communication & Security
router.get('/messages', studentController.getMessages);
router.post('/messages', studentController.sendMessage);
router.put('/change-password', studentController.changePassword);

export default router;
