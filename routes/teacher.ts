import express from 'express';
import { requireTeacher } from '../middleware/auth';
import {
  upload,
  getDashboardOverview,
  getRoster,
  getReminders,
  createReminder,
  toggleReminder,
  deleteReminder,
  getMessages,
  sendMessage,
  getProfile,
  uploadProfilePhoto,
  getExams,
  getStudents,
  getStudentPool,
  autoGenerateStudent,
  getScores,
  saveScores,
  saveAttendance,
  getAttendance,
  saveCommentary,
  generateCommentaryAi,
  batchGenerateCommentaryAi,
  batchSaveCommentary,
  getReportCards,
  getGradebookSheet,
  saveSingleGrade,
  batchSaveGradebook,
  uploadGradebookCsv,
  exportReportCardPdf,
  exportBatchReportCardsPdf,
  getMontessoriSheet,
  saveSingleMontessori,
  getHomeworks,
  createHomework,
  getHomeworkSubmissions,
  gradeHomeworkSubmission,
  getOnlineExams,
  createOnlineExam,
  getQuestionBank,
  createQuestionBankItem,
  updateQuestionBankItem,
  deleteQuestionBankItem,
  distributeOnlineExam,
  getOnlineExamSubmissions,
  gradeOnlineExamSubmission,
  updateOnlineExam,
  deleteOnlineExam,
  scanGrades,
  getScanRecord,
  commitScanRecord,
  getMedia,
  uploadMedia,
  deleteMedia,
  generateLessonPlan,
  getLessonPlans,
  createLessonPlan,
  updateLessonPlan,
  exportLessonPlanPdf,
  createLiveRoom,
  getLiveRooms,
  getLiveRoomToken,
  getGamificationProfile,
  getGamificationLeaderboard,
  getAttritionDashboard,
  getAttritionDetail,
  takeAttritionAction,
  getTeacherClassesSections,
  getTeacherSubjects,
  getSubjectStudents,
  getEvents,
  getTeacherTimetable,
} from '../controllers/teacher';
import { importCbtQuestions, aiGenerateCbtQuestions } from '../controllers/admin/adminExamCbtController';
import { getPublicSchoolInfo } from '../controllers/publicTenant';

const router = express.Router();

// Role-based auth guard for teachers (or branch admins acting on teacher scope)
router.use(requireTeacher);

// Dashboard & Overview
router.get('/dashboard-overview', getDashboardOverview);
router.get('/roster', getRoster);
router.get('/events', getEvents);
router.get('/school-info', getPublicSchoolInfo);

// Classes & Subjects for Teacher
router.get('/classes-sections', getTeacherClassesSections);
router.get('/classes', getTeacherClassesSections);
router.get('/subjects', getTeacherSubjects);
router.get('/subjects/:assignId/students', getSubjectStudents);

// Reminders
router.get('/reminders', getReminders);
router.post('/reminders', createReminder);
router.put('/reminders/:id/toggle', toggleReminder);
router.delete('/reminders/:id', deleteReminder);

// Messages
router.get('/messages', getMessages);
router.post('/messages', sendMessage);

// Profile
router.get('/profile', getProfile);
router.post('/profile/upload-photo', upload.single('file'), uploadProfilePhoto);

// Exams & Student Rosters
router.get('/exams', getExams);
router.get('/students', getStudents);
router.get('/students/pool', getStudentPool);
router.post('/students/auto-generate', autoGenerateStudent);

// Scores & Attendance
router.get('/scores', getScores);
router.post('/scores', saveScores);
router.post('/attendance', saveAttendance);
router.get('/attendance', getAttendance);

// Qualitative Commentary
router.post('/commentary', saveCommentary);
router.post('/commentary/generate-ai', generateCommentaryAi);
router.post('/commentary/batch-generate-ai', batchGenerateCommentaryAi);
router.post('/commentary/batch-save', batchSaveCommentary);

// Gradebook & Score Sheets
router.get('/gradebook/sheet', getGradebookSheet);
router.post('/gradebook/save-single', saveSingleGrade);
router.post('/gradebook/batch-save', batchSaveGradebook);
router.post('/gradebook/csv-upload', uploadGradebookCsv);

// Report Cards
router.get('/report-cards', getReportCards);
router.get('/report-cards/export-pdf', exportReportCardPdf);
router.get('/report-cards/export-batch-pdf', exportBatchReportCardsPdf);

// Montessori Assessments
router.get('/montessori/sheet', getMontessoriSheet);
router.post('/montessori/save-single', saveSingleMontessori);

// Homework & Assignments
router.get('/homeworks', getHomeworks);
router.post('/homeworks', createHomework);
router.get('/homeworks/:id/submissions', getHomeworkSubmissions);
router.post('/homeworks/submissions/:id/grade', gradeHomeworkSubmission);

// Online Exams & CBT
router.get('/online-exams', getOnlineExams);
router.post('/online-exams', createOnlineExam);
router.post('/online-exams/distribute', distributeOnlineExam);
router.get('/online-exams/:id/submissions', getOnlineExamSubmissions);
router.post('/online-exams/submissions/:id/grade', gradeOnlineExamSubmission);
router.put('/online-exams/:id', updateOnlineExam);
router.delete('/online-exams/:id', deleteOnlineExam);

// Question Bank
router.get('/question-bank', getQuestionBank);
router.post('/question-bank', createQuestionBankItem);
router.post('/question-bank/import', importCbtQuestions);
router.post('/question-bank/ai-generate', aiGenerateCbtQuestions);
router.put('/question-bank/:id', updateQuestionBankItem);
router.delete('/question-bank/:id', deleteQuestionBankItem);

// OCR Score Sheet Scanner
router.post('/grades/scan', upload.single('file'), scanGrades);
router.get('/grades/scan/:id', getScanRecord);
router.post('/grades/scan/:id/commit', commitScanRecord);

// Media Library
router.get('/media', getMedia);
router.post('/media', upload.single('file'), uploadMedia);
router.delete('/media/:id', deleteMedia);

// Lesson Planner
router.post('/lesson-plan/generate', generateLessonPlan);
router.get('/lesson-plan', getLessonPlans);
router.post('/lesson-plan', createLessonPlan);
router.put('/lesson-plan/:id', updateLessonPlan);
router.get('/lesson-plan/:id/pdf', exportLessonPlanPdf);

// Live Rooms
router.post('/live-rooms', createLiveRoom);
router.get('/live-rooms', getLiveRooms);
router.get('/live-rooms/:roomName/token', getLiveRoomToken);

// Gamification
router.get('/gamification/profile', getGamificationProfile);
router.get('/gamification/leaderboard', getGamificationLeaderboard);

// Predictive Attrition Radar
router.get('/attrition/dashboard', getAttritionDashboard);
router.get('/attrition/detail/:studentId', getAttritionDetail);
router.post('/attrition/action/:alertId', takeAttritionAction);

// Timetable
router.get('/timetable', getTeacherTimetable);

export default router;
