export * from './staffController';
export * from './staffAttendanceController';
export * from './staffLeaveController';
export * from './staffPayrollController';
export * from './staffLetterController';

// Route Aliases
import { saveStaffAttendanceBatch } from './staffAttendanceController';
import { deleteTeacher } from './staffController';
import { createPayrollRun, getPayslipPdf } from './staffPayrollController';
import { aiGenerateEmploymentLetter, getEmploymentLetterPdf } from './staffLetterController';
import { createStaffConduct, getStaffConduct } from './staffPayrollController';

export const saveStaffAttendance = saveStaffAttendanceBatch;
export const deactivateTeacher = deleteTeacher;
export const processPayroll = createPayrollRun;
export const downloadPayslipPdf = getPayslipPdf;
export const aiDraftEmploymentLetter = aiGenerateEmploymentLetter;
export const downloadEmploymentLetterPdf = getEmploymentLetterPdf;
export const getConductLogs = getStaffConduct;
export const createConductLog = createStaffConduct;
