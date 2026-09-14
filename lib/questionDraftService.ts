import { getDeepseekClient } from './aiClient';
import { generateAiCurriculumQuestions, ParsedQuestion } from './cbtService';

export function approvedQuestionWhere() {
  return { status: 'APPROVED' as const }
}

export interface QuestionDraftParams {
  subjectName?: string;
  className?: string;
  topic?: string;
  termName?: string;
  instruction?: string;
  sourceMaterial?: string;
  questionType?: string;
  questionCount?: number;
}

export function mapQuestionBankWrite(body: any, extras: {
  branchId: number;
  sessionId?: number | null;
  createdById?: number | null;
  createdByRole?: string | null;
}) {
  return {
    questionText: String(body.questionText || '').trim(),
    questionType: body.questionType || 'mcq',
    options: Array.isArray(body.options) ? body.options : null,
    correctOption: body.correctOption || null,
    marks: body.marks !== undefined ? Number(body.marks) : 1,
    subjectId: Number(body.subjectId),
    classId: body.classId ? Number(body.classId) : null,
    sessionId: body.sessionId ? Number(body.sessionId) : extras.sessionId || null,
    termName: body.termName || null,
    topic: body.topic || null,
    difficulty: body.difficulty || 'medium',
    sourceType: body.sourceType || 'MANUAL',
    sourceFileName: body.sourceFileName || null,
    aiInstruction: body.aiInstruction || body.instruction || null,
    category: body.category || null,
    status: body.status || 'APPROVED',
    approvedAt: (body.status && body.status !== 'APPROVED') ? null : (body.approvedAt ? new Date(body.approvedAt) : new Date()),
    approvedById: extras.createdById || null,
    createdById: extras.createdById || null,
    createdByRole: extras.createdByRole || null,
    branchId: extras.branchId,
  };
}

export async function generateQuestionDrafts(params: QuestionDraftParams): Promise<ParsedQuestion[]> {
  const {
    subjectName = 'General Studies',
    className = 'Primary',
    topic = 'Core Concepts',
    termName = '',
    instruction = '',
    sourceMaterial = '',
    questionType = 'mcq',
    questionCount = 5,
  } = params;

  const count = Math.min(Math.max(Number(questionCount) || 5, 1), 20);
  const client = getDeepseekClient();

  if (client) {
    try {
      const completion = await client.chat.completions.create({
        model: 'deepseek-chat',
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a Nigerian curriculum examiner. Follow custom instructions. Prefer uploaded/scanned source material when provided. Return valid JSON only.',
          },
          {
            role: 'user',
            content: `Create ${count} ${questionType} questions.
Subject: ${subjectName}
Class: ${className}
Topic: ${topic}
Term: ${termName || 'Current term'}

Teacher / Admin instruction:
${instruction.trim() || 'Create classroom-ready questions with clear stems and one correct answer.'}

${sourceMaterial.trim()
  ? `Uploaded / scanned material (extract and rewrite as questions; do not ignore it):\n${sourceMaterial.trim().slice(0, 12000)}`
  : 'No source file. Generate from the topic and instruction.'}

Return JSON:
{ "questions": [ { "questionText": "", "questionType": "${questionType}", "options": ["A text","B text","C text","D text"], "correctOption": "A", "marks": 1, "explanation": "" } ] }`,
          },
        ],
      });

      const parsed = JSON.parse(completion.choices[0].message.content || '{}');
      const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
      const drafts = list
        .map((q: any) => ({
          questionText: String(q.questionText || '').trim(),
          questionType: q.questionType || questionType,
          options: Array.isArray(q.options) ? q.options.map((o: any) => String(o)) : [],
          correctOption: String(q.correctOption || 'A').trim().toUpperCase(),
          marks: Number(q.marks) || 1,
          explanation: q.explanation || '',
        }))
        .filter((q: ParsedQuestion) => q.questionText);
      if (drafts.length) return drafts.slice(0, count);
    } catch (error: any) {
      console.warn('[QuestionDraftService] DeepSeek fallback:', error?.message || error);
    }
  }

  return generateAiCurriculumQuestions({
    subjectName,
    topic,
    classLevel: className,
    questionCount: count,
    questionType,
  });
}
