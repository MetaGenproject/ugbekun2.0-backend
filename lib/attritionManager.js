const { calculateStudentAttritionRisk } = require('./attritionEngine');
const gamificationService = require('./gamificationService');
const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com'
});

/**
 * Evaluates risk indicators, logs records, deducts XP, and pre-drafts parent plans.
 * @param {number} studentId 
 * @param {any} prisma 
 */
async function processStudentAttritionRisk(studentId, prisma) {
  // 1. Calculate risk
  const risk = await calculateStudentAttritionRisk(studentId, prisma);

  // 2. Save/Update AttritionRisk in DB
  const riskRecord = await prisma.studentAttritionRisk.upsert({
    where: { studentId },
    create: {
      studentId: risk.studentId,
      attendanceScore: risk.attendanceScore,
      academicScore: risk.academicScore,
      financialScore: risk.financialScore,
      sentimentScore: risk.sentimentScore,
      compositeDrift: risk.compositeDrift,
      riskLevel: risk.riskLevel,
      isIsolated: risk.isIsolated
    },
    update: {
      attendanceScore: risk.attendanceScore,
      academicScore: risk.academicScore,
      financialScore: risk.financialScore,
      sentimentScore: risk.sentimentScore,
      compositeDrift: risk.compositeDrift,
      riskLevel: risk.riskLevel,
      isIsolated: risk.isIsolated,
      lastEvaluatedAt: new Date()
    }
  });

  // If riskLevel is HIGH or MEDIUM, create an InterventionAlert and draft plan
  if (risk.riskLevel === 'HIGH' || risk.riskLevel === 'MEDIUM') {
    // Find student enroll to resolve branch, session, class, and section
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrolls: {
          orderBy: { id: 'desc' },
          take: 1
        }
      }
    });

    const enroll = student?.enrolls[0];
    let formTeacherId = null;

    if (enroll) {
      const allocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: enroll.classId,
          sectionId: enroll.sectionId,
          sessionId: enroll.sessionId
        }
      });
      if (allocation?.teacherId) {
        formTeacherId = allocation.teacherId;
      }
    }

    if (formTeacherId) {
      // Check if there's already an active alert for this risk record and teacher
      const existingAlert = await prisma.interventionAlert.findFirst({
        where: {
          riskId: riskRecord.id,
          teacherId: formTeacherId,
          status: 'PENDING'
        }
      });

      if (!existingAlert) {
        // Generate AI plan using Deepseek
        let parentPlan = null;
        let remediationSteps = [];
        try {
          // Fetch student commentary text for LLM context
          const commentaries = await prisma.studentCommentary.findMany({
            where: { studentId },
            select: { remark: true },
            take: 2
          });
          const notesText = commentaries.map(c => c.remark).join('; ') || 'No specific behavioral remarks.';

          const completion = await openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: 'You are an expert student intervention counselor. You formulate empathetic, constructive Parent Engagement Plans.'
              },
              {
                role: 'user',
                content: `Formulate a Parent Engagement Plan for the student based on these diagnostic metrics:
- Recent Attendance Dip: ${Math.round(risk.attendanceScore * 100)}% deviation from baseline
- Academic Grade Drop: ${Math.round(risk.academicScore * 100)}% decline in assignment grades
- Teacher Commentary Notes: "${notesText}"

Do not mention internal system risk scores, percentages, or the term "attrition risk" to the parent. Draft the plan under these markdown sections:
1. Observations (Empathetic description of recent patterns in attendance and homework)
2. Targeted Remediation Steps (Actionable tasks for home study, extra help sessions)
3. School-Home Check-ins (Frequency of progress updates)`
              }
            ],
            temperature: 0.7
          });

          parentPlan = completion.choices[0]?.message?.content;
          remediationSteps = [
            `Discuss attendance deviation of ${Math.round(risk.attendanceScore * 100)}% with parents.`,
            `Set up study plan to address the academic drop of ${Math.round(risk.academicScore * 100)}%.`,
            `Schedule a parent-teacher meeting.`
          ];
        } catch (llmErr) {
          console.error('[Attrition Engine] Deepseek plan generation failed:', llmErr.message);
          parentPlan = `AI Plan generation failed. Please engage the parents regarding recent declines in continuous assessment and room attendance rates.`;
          remediationSteps = ['Address academic grade drop.', 'Check attendance logs.', 'Schedule parent meeting.'];
        }

        // Create the InterventionAlert
        await prisma.interventionAlert.create({
          data: {
            riskId: riskRecord.id,
            teacherId: formTeacherId,
            status: 'PENDING',
            parentPlan,
            remediationSteps
          }
        });
      }
    }
  }

  // 3. Deduct XP if risk is HIGH and deduction is configured
  if (risk.xpDeduction < 0) {
    try {
      // Form weekly key to prevent double deduction in the same week
      const date = new Date();
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date);
      monday.setDate(diff);
      const weekKey = `${monday.getFullYear()}-W-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

      await gamificationService.awardPoints(prisma, {
        actorType: 'STUDENT',
        actorId: studentId,
        points: risk.xpDeduction,
        actionType: 'ENGAGEMENT_DECLINE',
        referenceEntity: 'StudentAttritionRisk',
        referenceId: riskRecord.id,
        branchId: risk.branchId,
        metadata: { drift: risk.compositeDrift, weekKey }
      });
    } catch (gErr) {
      console.warn('[Attrition Engine] XP deduction skipped (likely due to idempotency or limit):', gErr.message);
    }
  }

  return riskRecord;
}

module.exports = {
  processStudentAttritionRisk
};
