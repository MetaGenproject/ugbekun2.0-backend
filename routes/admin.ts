import { Router } from 'express';
import multer from 'multer';
import { requireBranchAdmin } from '../middleware/auth';

// Domain Controllers
import {
  getAdminStats,
  getStaffActivity,
  getComprehensiveReports,
  getGamificationConfig,
  updateGamificationConfig,
} from '../controllers/admin/adminStatsController';

import {
  getStudentsParents,
  searchParents,
  onboardStudentWithPhoto,
  bulkImportStudents,
  exportCredentialSlips,
  promoteStudents,
  getStudentProfile,
  updateStudentProfile,
  uploadStudentPhoto,
  uploadParentPhoto,
  toggleStudentStatus,
  updateStudent,
  deleteStudent,
  updateParent,
  deleteParent,
  getParentMessages,
  sendParentMessage,
  updateParentMessage,
  deleteParentMessage,
  sendParentBroadcast,
  processSiblingRequest,
  getSiblingRequests,
  approveSiblingRequest,
  rejectSiblingRequest,
  getClassroomStudents,
  getOnlineAdmissions,
  reviewOnlineAdmission,
  parseStudentDocument,
  getIdCards,
  getIdCardsStats,
  getStudentsForIdCards,
  getStaffForIdCards,
  provisionIdCardHandler,
  provisionStudentIdCardHandler,
  provisionStaffIdCardHandler,
  batchProvisionIdCardsHandler,
  revokeIdCardHandler,
  downloadIdCardPdf,
  getIdCardTemplateConfig,
  saveIdCardTemplateConfig,
  getCertificates,
  issueCertificate,
  downloadCertificatePdf,
} from '../controllers/admin/adminStudentController';

import {
  getTeachersStaff,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  onboardTeacher,
  updateTeacher,
  deactivateTeacher,
  uploadTeacherPhoto,
  uploadStaffPhoto,
  toggleTeacherStatus,
  toggleStaffStatus,
  updateStaff,
  getStaffMessages,
  sendStaffMessage,
  getStaffAttendance,
  saveStaffAttendance,
  getLeaveCategories,
  createLeaveCategory,
  getLeaveRequests,
  reviewLeaveRequest,
  getPayrollComponents,
  createPayrollComponent,
  getPayrollRuns,
  processPayroll,
  downloadPayslipPdf,
  getSalaryAdvances,
  createSalaryAdvance,
  reviewSalaryAdvance,
  getConductLogs,
  createConductLog,
  getEmploymentLetters,
  aiDraftEmploymentLetter,
  createEmploymentLetter,
  downloadEmploymentLetterPdf,
} from '../controllers/admin/adminStaffController';

import {
  getClasses,
  getClassesSections,
  createClass,
  updateClass,
  deleteClass,
  seedClassPresets,
  toggleClassEcd,
  createSection,
  updateSection,
  deleteSection,
  allocateSection,
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  assignSubject,
  assignSubjectBulk,
  deleteSubjectAssignment,
  getStudentAttendance,
  saveStudentAttendance,
  getPromotionSelection,
  promoteStudentCohort,
  getPromotionHistory,
  getLibraryResources,
  createLibraryResource,
  aiDraftEbookResource,
  issueLibraryBook,
  returnLibraryBook,
  deleteLibraryResource,
  getLessonPlans,
  exportLessonPlanPdf,
} from '../controllers/admin/adminAcademicsController';

import {
  getTimetable,
  createTimetableSlot,
  deleteTimetableSlot,
  clearTimetable,
  aiGenerateTimetable,
  publishTimetable,
  getTimetableSessions,
} from '../controllers/admin/adminTimetableController';

import {
  getExams,
  createExam,
  updateExam,
  deleteExam,
  getEvaluationMatrices,
  createEvaluationMatrix,
  updateEvaluationMatrix,
  deleteEvaluationMatrix,
  setDefaultEvaluationMatrix,
  assignMatrixToClass,
  getExamHalls,
  createExamHall,
  updateExamHall,
  deleteExamHall,
  getExamSchedule,
  createExamScheduleSlot,
  deleteExamScheduleSlot,
  publishExamSchedule,
  clearExamSchedule,
  getCbtGroups,
  createCbtGroup,
  deleteCbtGroup,
  getCbtDistributions,
  createCbtDistribution,
  togglePublishCbtDistribution,
  deleteCbtDistribution,
  getCbtQuestionBank,
  createCbtQuestion,
  updateCbtQuestion,
  deleteCbtQuestion,
  importCbtQuestions,
  aiGenerateCbtQuestions,
  getCbtDistributionAnalytics,
  syncCbtMarks,
  syncCbtLegacy,
} from '../controllers/admin/adminExamCbtController';

import {
  getMarksEntry,
  saveMarksEntryBatch,
  aiDistributeMarks,
  getPendingCommentary,
  reviewCommentary,
  getReportCardClasses,
  getReportCardStudents,
  exportReportCardPdf,
  exportBatchReportCardsPdf,
  saveReportCardCommentary,
  saveReportCardBehavioral,
  generateAiComments,
  batchGenerateCommentary,
  batchSaveCommentary,
} from '../controllers/admin/adminMarksReportController';

import {
  getFinanceOverview,
  getFeeTypes,
  createFeeType,
  bulkCreateFeeTypes,
  getFeeAssignments,
  saveFeeAssignments,
  previewBatchInvoices,
  generateBatchInvoices,
  getSingleInvoicePdf,
  getBatchInvoicesPdf,
  getInvoices,
  createInvoice,
  recordInvoicePayment,
  exportFinanceCsv,
  exportFinancePdf,
  getFeeGroups,
  createFeeGroup,
  bulkDuesPost,
  bulkPaymentsPost,
  sendParentReminder,
  getCollectionsReport,
  getVoucherHeads,
  createVoucherHead,
  getOfficeTransactions,
  createOfficeTransaction,
  getSchoolBank,
  updateSchoolBank,
} from '../controllers/admin/adminFinanceController';

import {
  getEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getSettings,
  updateSettings,
  resetSchoolInfo,
  deleteBrandingAsset,
  uploadLogo,
  getSchoolInfo,
  uploadAdminPhoto,
  getInventory,
  createInventoryItem,
  recordInventoryPurchase,
  recordInventorySale,
  deleteInventoryItem,
  getMyEduRideConfigHandler,
  saveMyEduRideConfigHandler,
  testMyEduRideConnectionHandler,
  syncRosterHandler,
  getMyEduRideOverview,
  getMyEduRideBuses,
  getGateLogsHandler,
  scanGateLogHandler,
  boardManifestHandler,
  exportGateLogsCsvHandler,
  exportGateLogsPdfHandler,
  getLandingPageConfig,
  updateLandingPageConfig,
  getDomainConfig,
  updateDomain,
  verifyDns,
  removeDomain,
} from '../controllers/admin/adminSettingsCmsController';

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// UNRESTRICTED / UNIVERSAL ROLE LOOKUPS (e.g. Navigation Header info)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/school-info', getSchoolInfo);
router.post('/profile/upload-photo', upload.single('file'), uploadAdminPhoto);

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH ADMIN ROLE-PROTECTED ROUTE MAPPINGS
// ─────────────────────────────────────────────────────────────────────────────
router.use(requireBranchAdmin);

// ============================================================================
// 1. STATS, OVERVIEW, REPORTS & GAMIFICATION
// ============================================================================
router.get('/stats', getAdminStats);
router.get('/staff-activity', getStaffActivity);
router.get('/reports/comprehensive', getComprehensiveReports);
router.get('/gamification/config', getGamificationConfig);
router.post('/gamification/config', updateGamificationConfig);

// ============================================================================
// 2. STUDENTS, PARENTS, ADMISSIONS, ID CARDS & CERTIFICATES
// ============================================================================
router.get('/students-parents', getStudentsParents);
router.get('/parents/search', searchParents);
router.post('/students/onboard-with-photo', upload.single('file'), onboardStudentWithPhoto);
router.post('/students/onboard', upload.single('file'), onboardStudentWithPhoto);
router.post('/students/bulk-import', upload.single('file'), bulkImportStudents);
router.get('/students/export-credential-slips', exportCredentialSlips);
router.post('/students/promote', promoteStudents);
router.get('/students/:id/profile', getStudentProfile);
router.put('/students/:id/profile', updateStudentProfile);
router.post('/students/:id/upload-photo', upload.single('file'), uploadStudentPhoto);
router.post('/parents/:id/upload-photo', upload.single('file'), uploadParentPhoto);
router.put('/parents/:id', updateParent);
router.delete('/parents/:id', deleteParent);

// Parent EduChat Communication Endpoints
router.get('/parents/:parentId/messages', getParentMessages);
router.post('/parents/:parentId/messages', sendParentMessage);
router.put('/parent-messages/:messageId', updateParentMessage);
router.delete('/parent-messages/:messageId', deleteParentMessage);
router.post('/parents/broadcast', sendParentBroadcast);
router.post('/students/:id/toggle-status', toggleStudentStatus);
router.put('/students/:id', updateStudent);
router.delete('/students/:id', deleteStudent);
router.post('/students/sibling-request', processSiblingRequest);
router.get('/sibling-requests', getSiblingRequests);
router.post('/sibling-requests/:id/approve', approveSiblingRequest);
router.post('/sibling-requests/:id/reject', rejectSiblingRequest);
router.get('/classroom-students', getClassroomStudents);
router.get('/classrooms/:id/students', getClassroomStudents);
router.get('/online-admissions', getOnlineAdmissions);
router.post('/online-admissions/:id/review', reviewOnlineAdmission);
router.post('/students/parse-document', upload.single('file'), parseStudentDocument);

router.get('/id-cards', getIdCards);
router.get('/id-cards/stats', getIdCardsStats);
router.get('/id-cards/students', getStudentsForIdCards);
router.get('/id-cards/staff', getStaffForIdCards);
router.post('/id-cards/provision', provisionIdCardHandler);
router.post('/id-cards/provision/student/:studentId', provisionStudentIdCardHandler);
router.post('/id-cards/provision/staff/:userId', provisionStaffIdCardHandler);
router.post('/id-cards/provision/batch', batchProvisionIdCardsHandler);
router.post('/id-cards/batch-provision', batchProvisionIdCardsHandler);
router.post('/id-cards/revoke', revokeIdCardHandler);
router.put('/id-cards/:cardId/revoke', revokeIdCardHandler);
router.get('/id-cards/download-pdf', downloadIdCardPdf);
router.get('/id-cards/:cardId/download', downloadIdCardPdf);
router.get('/id-cards/:cardId/download-pdf', downloadIdCardPdf);
router.get('/id-cards/template-config', getIdCardTemplateConfig);
router.post('/id-cards/template-config', saveIdCardTemplateConfig);
router.get('/card-template', getIdCardTemplateConfig);
router.put('/card-template', saveIdCardTemplateConfig);
router.post('/card-template', saveIdCardTemplateConfig);

router.get('/credentials-slips/class-pdf', exportCredentialSlips);

router.get('/certificates', getCertificates);
router.post('/certificates/issue', issueCertificate);
router.get('/certificates/:id/download', downloadCertificatePdf);
router.get('/certificates/:id/download-pdf', downloadCertificatePdf);

// ============================================================================
// 3. TEACHERS, STAFF & HUMAN RESOURCES (HR)
// ============================================================================
router.get('/teachers-staff', getTeachersStaff);
router.get('/roles', getRoles);
router.post('/roles', createRole);
router.put('/roles/:id', updateRole);
router.delete('/roles/:id', deleteRole);
router.post('/teachers/onboard', onboardTeacher);
router.put('/teachers/:id', updateTeacher);
router.delete('/teachers/:id', deactivateTeacher);
router.post('/staff/:id/upload-photo', upload.single('file'), uploadStaffPhoto);
router.post('/teachers/:id/upload-photo', upload.single('file'), uploadTeacherPhoto);
router.post('/teachers/:id/toggle-status', toggleTeacherStatus);
router.post('/staff/:id/toggle-status', toggleStaffStatus);
router.put('/staff/:id', updateStaff);
router.get('/staff-messages', getStaffMessages);
router.post('/staff-messages', sendStaffMessage);
router.get('/staff/attendance', getStaffAttendance);
router.post('/staff/attendance', saveStaffAttendance);

router.get('/hr/leave-categories', getLeaveCategories);
router.post('/hr/leave-categories', createLeaveCategory);
router.get('/hr/leave-requests', getLeaveRequests);
router.post('/hr/leave-requests/:id/review', reviewLeaveRequest);

router.get('/hr/payroll/components', getPayrollComponents);
router.post('/hr/payroll/components', createPayrollComponent);
router.get('/hr/payroll/runs', getPayrollRuns);
router.post('/hr/payroll/process', processPayroll);
router.get('/hr/payroll/runs/:id/payslip/:staffId', downloadPayslipPdf);

router.get('/hr/salary-advances', getSalaryAdvances);
router.post('/hr/salary-advances', createSalaryAdvance);
router.post('/hr/salary-advances/:id/review', reviewSalaryAdvance);

router.get('/hr/conduct-logs', getConductLogs);
router.post('/hr/conduct-logs', createConductLog);

router.get('/hr/employment-letters', getEmploymentLetters);
router.post('/hr/employment-letters/ai-draft', aiDraftEmploymentLetter);
router.post('/hr/employment-letters', createEmploymentLetter);
router.get('/hr/employment-letters/:id/download-pdf', downloadEmploymentLetterPdf);

// ============================================================================
// 4. ACADEMICS, CURRICULUM, SECTIONS & LIBRARY
// ============================================================================
router.get('/classes', getClasses);
router.get('/classes-sections', getClassesSections);
router.post('/classes', createClass);
router.put('/classes/:id', updateClass);
router.delete('/classes/:id', deleteClass);
router.post('/classes/seed-presets', seedClassPresets);
router.post('/classes/seed-preset', seedClassPresets);
router.post('/classes/:id/toggle-ecd', toggleClassEcd);
router.post('/sections', createSection);
router.put('/sections/:id', updateSection);
router.delete('/sections/:id', deleteSection);
router.post('/sections/allocate', allocateSection);
router.get('/subjects', getSubjects);
router.post('/subjects', createSubject);
router.put('/subjects/:id', updateSubject);
router.delete('/subjects/:id', deleteSubject);
router.post('/subjects/assign', assignSubject);
router.post('/subjects/assign-bulk', assignSubjectBulk);
router.delete('/subjects/assign/:id', deleteSubjectAssignment);
router.get('/student-attendance', getStudentAttendance);
router.post('/student-attendance', saveStudentAttendance);
router.get('/promotion/selection', getPromotionSelection);
router.get('/promotions/class-students', getPromotionSelection);
router.post('/promotion/promote', promoteStudentCohort);
router.post('/promotions/batch', promoteStudentCohort);
router.get('/promotion/history', getPromotionHistory);
router.get('/promotions/history', getPromotionHistory);

router.get('/library/resources', getLibraryResources);
router.post('/library/resources', createLibraryResource);
router.post('/library/resources/ai-ebook-draft', aiDraftEbookResource);
router.post('/library/issues', issueLibraryBook);
router.post('/library/returns', returnLibraryBook);
router.delete('/library/resources/:id', deleteLibraryResource);

router.get('/lesson-plans', getLessonPlans);
router.get('/lesson-plans/:id/export-pdf', exportLessonPlanPdf);

// ============================================================================
// 5. TIMETABLE & AI SCHEDULING
// ============================================================================
router.get('/timetable/sessions', getTimetableSessions);
router.get('/timetable', getTimetable);
router.post('/timetable/slot', createTimetableSlot);
router.delete('/timetable/slot/:id', deleteTimetableSlot);
router.post('/timetable/publish', publishTimetable);
router.post('/timetable/clear', clearTimetable);
router.post('/timetable/ai-generate', aiGenerateTimetable);

// ============================================================================
// 6. EXAMS, EVALUATION MATRICES, HALLS & CBT ENGINE
// ============================================================================
router.get('/exams', getExams);
router.post('/exams', createExam);
router.put('/exams/:id', updateExam);
router.delete('/exams/:id', deleteExam);
router.get('/evaluation-matrices', getEvaluationMatrices);
router.post('/evaluation-matrices', createEvaluationMatrix);
router.put('/evaluation-matrices/:id', updateEvaluationMatrix);
router.delete('/evaluation-matrices/:id', deleteEvaluationMatrix);
router.post('/evaluation-matrices/:id/set-default', setDefaultEvaluationMatrix);
router.post('/evaluation-matrices/assign-class', assignMatrixToClass);
router.get('/exam-halls', getExamHalls);
router.post('/exam-halls', createExamHall);
router.put('/exam-halls/:id', updateExamHall);
router.delete('/exam-halls/:id', deleteExamHall);
router.get('/exam-schedule', getExamSchedule);
router.post('/exam-schedule/slot', createExamScheduleSlot);
router.delete('/exam-schedule/slot/:id', deleteExamScheduleSlot);
router.post('/exam-schedule/publish', publishExamSchedule);
router.post('/exam-schedule/clear', clearExamSchedule);

router.get('/cbt/groups', getCbtGroups);
router.post('/cbt/groups', createCbtGroup);
router.delete('/cbt/groups/:id', deleteCbtGroup);
router.get('/cbt/distributions', getCbtDistributions);
router.post('/cbt/distributions', createCbtDistribution);
router.post('/cbt/distributions/:id/toggle-publish', togglePublishCbtDistribution);
router.delete('/cbt/distributions/:id', deleteCbtDistribution);
router.get('/cbt/question-bank', getCbtQuestionBank);
router.post('/cbt/question-bank', createCbtQuestion);
router.put('/cbt/question-bank/:id', updateCbtQuestion);
router.delete('/cbt/question-bank/:id', deleteCbtQuestion);
router.post('/cbt/question-bank/import', importCbtQuestions);
router.post('/cbt/question-bank/ai-generate', aiGenerateCbtQuestions);
router.get('/cbt/distributions/:id/analytics', getCbtDistributionAnalytics);
router.post('/cbt/distributions/:id/sync-marks', syncCbtMarks);
router.post('/cbt/sync', syncCbtLegacy);

// ============================================================================
// 7. MARKS ENTRY, COMMENTARY & REPORT CARDS
// ============================================================================
router.get('/marks-entry', getMarksEntry);
router.post('/marks-entry/batch-save', saveMarksEntryBatch);
router.post('/marks-entry/ai-distribute', aiDistributeMarks);
router.get('/commentary/pending', getPendingCommentary);
router.post('/commentary/review', reviewCommentary);
router.get('/report-cards/classes', getReportCardClasses);
router.get('/report-cards/students', getReportCardStudents);
router.get('/report-cards/export-pdf', exportReportCardPdf);
router.get('/report-cards/export-batch-pdf', exportBatchReportCardsPdf);
router.post('/report-cards/commentary', saveReportCardCommentary);
router.post('/report-cards/behavioral', saveReportCardBehavioral);
router.post('/report-cards/ai-comments', generateAiComments);
router.post('/report-cards/batch-generate-commentary', batchGenerateCommentary);
router.post('/report-cards/batch-save-commentary', batchSaveCommentary);

// ============================================================================
// 8. FINANCES, INVOICES, PAYMENTS, VOUCHERS & BANK
// ============================================================================
router.get('/finances/overview', getFinanceOverview);
router.get('/finances/fee-types', getFeeTypes);
router.post('/finances/fee-types', createFeeType);
router.post('/finances/fee-types/bulk', bulkCreateFeeTypes);
router.get('/finances/fee-assignments', getFeeAssignments);
router.post('/finances/fee-assignments', saveFeeAssignments);
router.get('/finances/invoices/batch-preview', previewBatchInvoices);
router.post('/finances/invoices/batch-preview', previewBatchInvoices);
router.post('/finances/invoices/batch-generate', generateBatchInvoices);
router.post('/finances/invoices/bulk', generateBatchInvoices);
router.get('/finances/invoices/:id/pdf', getSingleInvoicePdf);
router.get('/finances/invoices/batch-pdf', getBatchInvoicesPdf);
router.get('/finances/invoices', getInvoices);
router.post('/finances/invoices', createInvoice);
router.post('/finances/payments', recordInvoicePayment);
router.get('/finances/export/csv', exportFinanceCsv);
router.get('/finances/export/pdf', exportFinancePdf);
router.get('/finances/fee-groups', getFeeGroups);
router.post('/finances/fee-groups', createFeeGroup);
router.post('/finances/bulk-dues-post', bulkDuesPost);
router.post('/finances/bulk-payments-post', bulkPaymentsPost);
router.post('/finances/send-parent-reminder', sendParentReminder);
router.get('/finances/reports/collections', getCollectionsReport);
router.get('/finances/voucher-heads', getVoucherHeads);
router.post('/finances/voucher-heads', createVoucherHead);
router.get('/finances/office-transactions', getOfficeTransactions);
router.post('/finances/office-transactions', createOfficeTransaction);
router.get('/finances/school-bank', getSchoolBank);
router.post('/finances/school-bank', updateSchoolBank);
router.put('/finances/school-bank', updateSchoolBank);

// ============================================================================
// 9. EVENTS, SETTINGS, INVENTORY, MYEDURIDE, LANDING PAGE CMS & DOMAINS
// ============================================================================
router.get('/events', getEvents);
router.post('/events', createEvent);
router.put('/events/:id', updateEvent);
router.delete('/events/:id', deleteEvent);

router.get('/settings', getSettings);
router.post('/settings', updateSettings);
router.put('/settings/school-info', updateSettings);
router.delete('/settings/school-info', resetSchoolInfo);
router.put('/settings/branding', updateSettings);
router.delete('/settings/branding/assets/:assetType', deleteBrandingAsset);
router.post('/settings/upload-logo', upload.single('file'), uploadLogo);

router.get('/inventory', getInventory);
router.post('/inventory/items', createInventoryItem);
router.post('/inventory/purchase', recordInventoryPurchase);
router.post('/inventory/sale', recordInventorySale);
router.delete('/inventory/items/:id', deleteInventoryItem);

import {
  getUserCredentials,
  resetUserPassword,
} from '../controllers/admin/adminUserController';

router.get('/myeduride/config', getMyEduRideConfigHandler);
router.post('/myeduride/config', saveMyEduRideConfigHandler);
router.post('/myeduride/test-connection', testMyEduRideConnectionHandler);
router.post('/myeduride/sync-roster', syncRosterHandler);
router.get('/myeduride/overview', getMyEduRideOverview);
router.get('/myeduride/buses', getMyEduRideBuses);
router.get('/myeduride/gate-logs', getGateLogsHandler);
router.post('/myeduride/gate-logs/scan', scanGateLogHandler);
router.post('/myeduride/manifest/board', boardManifestHandler);
router.get('/myeduride/export/csv', exportGateLogsCsvHandler);
router.get('/myeduride/export/pdf', exportGateLogsPdfHandler);

router.get('/landing-page', getLandingPageConfig);
router.put('/landing-page', updateLandingPageConfig);
router.post('/landing-page', updateLandingPageConfig);

router.get('/domain/config', getDomainConfig);
router.post('/domain/update', updateDomain);
router.post('/domain/verify-dns', verifyDns);
router.delete('/domain/remove', removeDomain);

// User Credential Management & Global Reset
router.get('/users/:userId/credentials', getUserCredentials);
router.post('/users/:userId/reset-password', resetUserPassword);

export default router;
