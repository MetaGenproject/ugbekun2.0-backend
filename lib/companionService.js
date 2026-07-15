/**
 * companionService.js
 * AI Learning Companion — Deepseek-powered tutoring engine.
 * Builds a context-aware system prompt from the student's enrolled class,
 * subjects, and recent assessment performance, then calls Deepseek chat.
 */
const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com'
});

/**
 * Builds a rich system prompt injected with live student context.
 */
async function buildSystemPrompt(studentId, prisma) {
  try {
    // Fetch student with latest enrollment
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrolls: {
          orderBy: { id: 'desc' },
          take: 1,
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } }
          }
        }
      }
    });

    const enroll = student?.enrolls?.[0];
    const className = enroll?.class?.name || 'your current class';

    // Fetch subjects assigned to this class/section
    let subjectList = 'your enrolled subjects';
    if (enroll) {
      const assigns = await prisma.subjectAssign.findMany({
        where: { classId: enroll.classId, sectionId: enroll.sectionId },
        include: { subject: { select: { name: true } } }
      });
      if (assigns.length > 0) {
        subjectList = assigns.map(a => a.subject.name).join(', ');
      }
    }

    // Fetch recent assessment average (last 5 homework/exam scores)
    const hwScores = await prisma.homeworkSubmission.findMany({
      where: { studentId, score: { not: null } },
      select: { score: true },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    const examScores = await prisma.onlineExamSubmission.findMany({
      where: { studentId, totalMark: { not: null } },
      select: { totalMark: true },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    const allScores = [
      ...hwScores.map(s => s.score),
      ...examScores.map(s => s.totalMark)
    ];
    const avgScore = allScores.length > 0
      ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
      : null;

    const avgText = avgScore !== null
      ? `Their recent assessment average is ${avgScore}%.`
      : 'No recent assessments are available yet.';

    return `You are an AI learning companion for a Nigerian school student currently enrolled in ${className}.
The student's subjects this term are: ${subjectList}.
${avgText}

Your role is to:
1. Give clear, structured text explanations and concept breakdowns for any topic the student asks about.
2. Generate concise revision summaries when requested.
3. Use relatable, localized examples relevant to Nigerian students where possible.
4. Structure explanations as: (a) Plain-language definition, (b) Worked example, (c) Short revision summary.
5. NEVER give direct answers to homework questions — guide with Socratic questions instead.
6. Keep your tone encouraging, patient, and age-appropriate.
7. Respond in plain text only — do not use markdown formatting like **bold** or ## headers.`;
  } catch (err) {
    console.error('[Companion] Failed to build system prompt context:', err.message);
    return `You are a helpful AI learning companion for a Nigerian school student. 
Provide clear explanations, worked examples, and revision summaries. 
Never give direct homework answers — use Socratic guidance instead.
Respond in plain text only.`;
  }
}

/**
 * Sends a chat message, persists the exchange, and returns the AI response.
 * @param {number} studentId
 * @param {string} userMessage
 * @param {number|null} sessionId - Existing session ID, or null to create a new one
 * @param {any} prisma
 */
async function sendMessage(studentId, userMessage, sessionId, prisma) {
  // Load or create session
  let session;
  if (sessionId) {
    session = await prisma.aiCompanionSession.findFirst({
      where: { id: sessionId, studentId }
    });
    if (!session) throw new Error('Session not found or unauthorized.');
  }

  const systemPrompt = await buildSystemPrompt(studentId, prisma);
  const existingMessages = session ? (session.messages || []) : [];

  // Build the messages array for the API call
  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...existingMessages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ];

  // Call Deepseek
  const completion = await openai.chat.completions.create({
    model: 'deepseek-chat',
    messages: apiMessages,
    temperature: 0.6,
    max_tokens: 800
  });

  const assistantResponse = completion.choices[0]?.message?.content || 'I was unable to generate a response. Please try again.';
  const now = new Date().toISOString();

  const newMessages = [
    ...existingMessages,
    { role: 'user', content: userMessage, createdAt: now },
    { role: 'assistant', content: assistantResponse, createdAt: now }
  ];

  if (!session) {
    // Auto-generate title from the first user message (truncated)
    const autoTitle = userMessage.length > 60
      ? userMessage.slice(0, 57) + '...'
      : userMessage;

    session = await prisma.aiCompanionSession.create({
      data: {
        studentId,
        title: autoTitle,
        messages: newMessages
      }
    });
  } else {
    session = await prisma.aiCompanionSession.update({
      where: { id: session.id },
      data: { messages: newMessages }
    });
  }

  return {
    sessionId: session.id,
    title: session.title,
    response: assistantResponse,
    messageCount: newMessages.length
  };
}

module.exports = { sendMessage };
