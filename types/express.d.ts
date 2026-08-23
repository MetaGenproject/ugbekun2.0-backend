import * as express from 'express';

declare global {
  namespace Express {
    interface Request {
      userId?: any;
      adminId?: any;
      userRole?: any;
      role?: any;
      branchId?: any;
      branchIds?: any;
      studentId?: any;
      parentId?: any;
      childClassId?: any;
      childSectionId?: any;
      childSessionId?: any;
      studentBranchId?: any;
      classId?: any;
      sectionId?: any;
      sessionId?: any;
      teacherId?: any;
      isAdmin?: any;
      user?: any;
      file?: any;
      files?: any;
    }
  }
}
