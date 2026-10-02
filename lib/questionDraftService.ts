import { executeAiChatCompletion, getAiTemperature } from './aiClient';
import { generateAiCurriculumQuestions, ParsedQuestion } from './cbtService';

export function approvedQuestionWhere() {
  return { status: 'APPROVED' as const };
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

export function mapQuestionBankWrite(
  body: any,
  extras: {
    branchId: number;
    sessionId?: number | null;
    createdById?: number | null;
    createdByRole?: string | null;
  }
) {
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
    approvedAt:
      body.status && body.status !== 'APPROVED'
        ? null
        : body.approvedAt
        ? new Date(body.approvedAt)
        : new Date(),
    approvedById: extras.createdById || null,
    createdById: extras.createdById || null,
    createdByRole: extras.createdByRole || null,
    branchId: extras.branchId,
  };
}

/**
 * Robust deterministic question parser for scanned or pasted text.
 * Extracts questions, options (A-D), and correct answers directly from raw material
 * without relying on an external AI service.
 */
export function parseQuestionsFromRawText(
  rawText: string,
  options: { questionType?: string; count?: number; instruction?: string } = {}
): ParsedQuestion[] {
  if (!rawText || !rawText.trim()) return [];

  const targetType = options.questionType || 'mcq';
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('---'));

  const parsedList: ParsedQuestion[] = [];
  let current: {
    questionText: string;
    options: string[];
    correctOption: string;
    marks: number;
    explanation: string;
  } | null = null;

  const qStartRegex = /^(?:(?:question|q)\s*\d+[\s.:\-)]*|\d+[\s.:\-)])\s*(.*)/i;
  const optRegex = /^(?:(?:\(|\[)?([a-eA-E])(?:\)|\]|\.|\:|\-)\s*)(.*)/;
  const ansRegex =
    /^(?:ans(?:wer)?|correct(?:\s*option|\s*answer)?|key)\s*[:=\-]?\s*(?:option\s*)?([a-eA-E]|true|false)/i;

  const saveCurrent = () => {
    if (!current || !current.questionText.trim()) return;

    let finalType = targetType;
    let finalOptions = [...current.options];
    let finalCorrect = current.correctOption;

    if (finalType === 'true_false') {
      finalOptions = ['True', 'False'];
      if (finalCorrect !== 'B') finalCorrect = 'A';
    } else if (finalType === 'mcq') {
      if (finalOptions.length === 0) {
        finalOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
      } else if (finalOptions.length < 4) {
        const letters = ['A', 'B', 'C', 'D'];
        while (finalOptions.length < 4) {
          finalOptions.push(`Option ${letters[finalOptions.length]}`);
        }
      } else if (finalOptions.length > 4) {
        finalOptions = finalOptions.slice(0, 4);
      }
      if (!['A', 'B', 'C', 'D'].includes(finalCorrect)) {
        finalCorrect = 'A';
      }
    } else if (finalType === 'theory') {
      finalOptions = [];
    }

    parsedList.push({
      questionText: current.questionText.trim(),
      questionType: finalType,
      options: finalOptions,
      correctOption: finalCorrect,
      marks: current.marks || 1,
      explanation: current.explanation || '',
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const ansMatch = line.match(ansRegex);
    if (ansMatch && current) {
      const val = ansMatch[1].toUpperCase();
      if (val === 'TRUE') current.correctOption = 'A';
      else if (val === 'FALSE') current.correctOption = 'B';
      else current.correctOption = val;
      continue;
    }

    const optMatch = line.match(optRegex);
    if (optMatch && current) {
      const cleanOpt = optMatch[2].trim() || optMatch[1];
      current.options.push(cleanOpt);
      continue;
    }

    const qMatch = line.match(qStartRegex);
    if (qMatch) {
      saveCurrent();
      current = {
        questionText: qMatch[1].trim() || line,
        options: [],
        correctOption: 'A',
        marks: 1,
        explanation: '',
      };
      continue;
    }

    if (current) {
      if (current.options.length === 0) {
        current.questionText += ' ' + line;
      }
    } else {
      if (line.endsWith('?') || (lines[i + 1] && lines[i + 1].match(optRegex))) {
        current = {
          questionText: line,
          options: [],
          correctOption: 'A',
          marks: 1,
          explanation: '',
        };
      }
    }
  }

  saveCurrent();

  // If questions were parsed from the raw text, apply count if specified
  if (parsedList.length > 0) {
    const maxCount = options.count || parsedList.length;
    return parsedList.slice(0, maxCount);
  }

  return [];
}

/**
 * Cleans and safely extracts the JSON array from an AI response.
 */
function extractQuestionsFromJson(rawResponse: string): any[] {
  let cleaned = String(rawResponse || '').trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.questions)) return parsed.questions;
    if (Array.isArray(parsed?.drafts)) return parsed.drafts;
    if (Array.isArray(parsed?.data)) return parsed.data;
  } catch {
    // Attempt relaxed regex extraction of the questions array
    const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      try {
        const extracted = JSON.parse(arrayMatch[0]);
        if (Array.isArray(extracted)) return extracted;
      } catch {
        // ignore
      }
    }
  }

  return [];
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

  const count = Math.min(Math.max(Number(questionCount) || 5, 1), 30);
  const trimmedSource = String(sourceMaterial || '').trim();
  const trimmedInstruction = String(instruction || '').trim();

  // 1. Try AI Generation across available providers (DeepSeek, Groq, OpenAI)
  try {
    const systemPrompt = `You are a Senior Examination Officer and Curriculum Specialist for Nigerian primary and secondary schools adhering to the national curriculum (NERDC, WAEC, NECO, BECE).
CRITICAL DIRECTIVES:
1. HIGHEST PRIORITY - USER INSTRUCTION:
   You MUST strictly obey the teacher's instruction: "${trimmedInstruction || 'Extract/generate classroom-ready questions with one unambiguous answer.'}".
   If the instruction specifies certain questions (e.g. "extract questions 1 to 5", "focus on question 3", "convert to multiple choice", "change to true or false"), you MUST execute that specific instruction.

2. SOURCE MATERIAL GROUNDING:
   - If source material / scanned document is provided below, extract, adapt, or transform questions directly from it.
   - NEVER discard the user's uploaded questions to invent generic or unrelated topics.
   - If the source material contains existing questions, format and adapt THOSE EXACT questions according to the desired type (${questionType}) and instruction.

3. SCHEMA REQUIREMENT:
   Output ONLY valid JSON with this exact structure:
   {
     "questions": [
       {
         "questionText": "Question stem here",
         "questionType": "${questionType}",
         "options": ["Option A", "Option B", "Option C", "Option D"],
         "correctOption": "A",
         "marks": 1,
         "explanation": "Brief explanation"
       }
     ]
   }`;

    const userPrompt = `Generate or extract ${count} ${questionType} questions.
Subject: ${subjectName}
Class: ${className}
Topic: ${topic}
Term: ${termName || 'Current term'}

TEACHER INSTRUCTION (OBEY STRICTLY):
${trimmedInstruction || 'Extract questions faithfully and format with 4 options and correct answer.'}

SOURCE MATERIAL (UPLOADED / SCANNED / PASTED CONTENT):
${
  trimmedSource
    ? trimmedSource.slice(0, 16000)
    : 'No source file was uploaded. Generate original, curriculum-aligned questions based on the topic and instruction above.'
}

Output valid JSON only.`;

    const aiResult = await executeAiChatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormatJson: true,
      temperature: 0.3,
    });

    const rawQuestions = extractQuestionsFromJson(aiResult.content);

    if (rawQuestions.length > 0) {
      const normalized: ParsedQuestion[] = rawQuestions
        .map((q: any) => {
          const qType = q.questionType || questionType;
          let opts: string[] = [];

          if (qType === 'true_false') {
            opts = ['True', 'False'];
          } else if (qType === 'mcq') {
            if (Array.isArray(q.options) && q.options.length) {
              opts = q.options.map((o: any) => {
                const s = String(o || '').trim();
                // Clean up accidental double lettering like "A. Option A"
                return s.replace(/^[A-Da-d][.):\-]\s*/, '').trim() || s;
              });
              while (opts.length < 4) {
                const letters = ['A', 'B', 'C', 'D'];
                opts.push(`Option ${letters[opts.length]}`);
              }
              if (opts.length > 4) opts = opts.slice(0, 4);
            } else {
              opts = ['Option A', 'Option B', 'Option C', 'Option D'];
            }
          }

          let correct = String(q.correctOption || 'A').trim().toUpperCase();
          if (correct === 'TRUE') correct = 'A';
          if (correct === 'FALSE') correct = 'B';
          if (!['A', 'B', 'C', 'D'].includes(correct)) correct = 'A';

          return {
            questionText: String(q.questionText || q.question || '').trim(),
            questionType: qType,
            options: opts,
            correctOption: correct,
            marks: Number(q.marks) || 1,
            explanation: q.explanation || '',
          };
        })
        .filter((q: ParsedQuestion) => q.questionText.length > 0);

      if (normalized.length > 0) {
        return normalized.slice(0, count);
      }
    }
  } catch (error: any) {
    console.warn('[QuestionDraftService] AI generation error:', error?.message || error);
  }

  // 2. Fallback: If source material exists, extract directly from the source material using local parser
  if (trimmedSource) {
    console.log('[QuestionDraftService] Using deterministic source material extractor fallback.');
    const parsedFromSource = parseQuestionsFromRawText(trimmedSource, {
      questionType,
      count,
      instruction: trimmedInstruction,
    });
    if (parsedFromSource.length > 0) {
      return parsedFromSource;
    }
  }

  // 3. Final Fallback: Generate curriculum questions based on topic and subject
  return generateAiCurriculumQuestions({
    subjectName,
    topic,
    classLevel: className,
    questionCount: count,
    questionType,
  });
}
