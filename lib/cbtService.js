/**
 * CBT Online Exam & Question Bank Processing Service
 * Provides multi-format parsers (Aiken, CSV, JSON), auto-grading algorithms,
 * and AI curriculum question generators.
 */

/**
 * Parses questions formatted in Aiken standard format.
 * Standard syntax:
 *   Question sentence?
 *   A. Option 1
 *   B. Option 2
 *   C. Option 3
 *   D. Option 4
 *   ANSWER: B
 */
function parseAikenFormat(text) {
  if (!text || typeof text !== 'string') return []

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const questions = []
  let currentQuestion = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Check if line is ANSWER: X
    const answerMatch = line.match(/^ANSWER\s*:\s*([A-Z0-9]+)/i)
    if (answerMatch) {
      if (currentQuestion && currentQuestion.questionText && currentQuestion.options.length >= 2) {
        currentQuestion.correctOption = answerMatch[1].toUpperCase()
        questions.push(currentQuestion)
      }
      currentQuestion = null
      continue
    }

    // Check if line is an Option: A. Text or A) Text
    const optionMatch = line.match(/^([A-Z])[\.\)]\s*(.+)$/i)
    if (optionMatch) {
      if (!currentQuestion) {
        // Option without question prompt, skip
        continue
      }
      currentQuestion.options.push(optionMatch[2].trim())
      continue
    }

    // If we reach here, it's a new question prompt
    if (currentQuestion) {
      // If previous question was accumulating text
      if (currentQuestion.options.length === 0) {
        currentQuestion.questionText += ' ' + line
      } else {
        // Incomplete question encountered, reset
        currentQuestion = {
          questionText: line,
          questionType: 'mcq',
          options: [],
          correctOption: 'A',
          marks: 1.0
        }
      }
    } else {
      currentQuestion = {
        questionText: line,
        questionType: 'mcq',
        options: [],
        correctOption: 'A',
        marks: 1.0
      }
    }
  }

  return questions
}

/**
 * Parses questions from CSV text.
 * Expected headers (case-insensitive):
 * question_text | question, question_type | type, option_a, option_b, option_c, option_d, correct_option | answer, marks | score
 */
function parseCsvFormat(csvText) {
  if (!csvText || typeof csvText !== 'string') return []

  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return []

  // Simple CSV parser supporting quotes
  const parseLine = (str) => {
    const result = []
    let cur = ''
    let insideQuote = false
    for (let i = 0; i < str.length; i++) {
      const c = str[i]
      if (c === '"') {
        insideQuote = !insideQuote
      } else if (c === ',' && !insideQuote) {
        result.push(cur.trim())
        cur = ''
      } else {
        cur += c
      }
    }
    result.push(cur.trim())
    return result
  }

  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/[\s_-]+/g, ''))
  const questions = []

  const qIdx = headers.findIndex(h => h.includes('question') || h === 'prompt' || h === 'text')
  const typeIdx = headers.findIndex(h => h.includes('type'))
  const optAIdx = headers.findIndex(h => h.includes('optiona') || h === 'a')
  const optBIdx = headers.findIndex(h => h.includes('optionb') || h === 'b')
  const optCIdx = headers.findIndex(h => h.includes('optionc') || h === 'c')
  const optDIdx = headers.findIndex(h => h.includes('optiond') || h === 'd')
  const ansIdx = headers.findIndex(h => h.includes('correct') || h.includes('answer') || h === 'ans')
  const marksIdx = headers.findIndex(h => h.includes('mark') || h.includes('point') || h.includes('score'))

  if (qIdx === -1) return []

  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i])
    if (row.length === 0 || !row[qIdx]) continue

    const qText = row[qIdx]
    const qType = (typeIdx !== -1 && row[typeIdx]) ? row[typeIdx].toLowerCase() : 'mcq'
    const options = []

    if (optAIdx !== -1 && row[optAIdx]) options.push(row[optAIdx])
    if (optBIdx !== -1 && row[optBIdx]) options.push(row[optBIdx])
    if (optCIdx !== -1 && row[optCIdx]) options.push(row[optCIdx])
    if (optDIdx !== -1 && row[optDIdx]) options.push(row[optDIdx])

    // If options are empty for true/false
    if (options.length === 0 && (qType === 'tf' || qType === 'true_false')) {
      options.push('True', 'False')
    }

    let correctOption = (ansIdx !== -1 && row[ansIdx]) ? row[ansIdx].toUpperCase() : 'A'
    // Normalize correct option (e.g. if text is "True" or "1", normalize)
    if (correctOption === 'TRUE') correctOption = 'A'
    if (correctOption === 'FALSE') correctOption = 'B'

    const marks = (marksIdx !== -1 && !isNaN(parseFloat(row[marksIdx]))) ? parseFloat(row[marksIdx]) : 1.0

    questions.push({
      questionText: qText,
      questionType: qType.includes('tf') ? 'true_false' : 'mcq',
      options: options.length > 0 ? options : ['Option A', 'Option B', 'Option C', 'Option D'],
      correctOption,
      marks
    })
  }

  return questions
}

/**
 * Parses JSON format questions array.
 */
function parseJsonFormat(jsonText) {
  if (!jsonText) return []
  try {
    const parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText
    if (!Array.isArray(parsed)) {
      if (parsed.questions && Array.isArray(parsed.questions)) return parsed.questions
      return []
    }

    return parsed.map((item, idx) => ({
      questionText: item.questionText || item.question || item.text || `Question ${idx + 1}`,
      questionType: item.questionType || item.type || 'mcq',
      options: Array.isArray(item.options) ? item.options : ['A', 'B', 'C', 'D'],
      correctOption: String(item.correctOption || item.answer || item.correctAnswer || 'A').toUpperCase(),
      marks: Number(item.marks || item.points || 1.0)
    }))
  } catch (e) {
    return []
  }
}

/**
 * Generates AI curriculum-aligned questions for a given subject and topic.
 */
function generateAiCurriculumQuestions({ subjectName = 'General Studies', topic = 'Core Concepts', classLevel = 'Secondary', questionCount = 5, questionType = 'mcq' }) {
  const count = Math.min(Math.max(parseInt(questionCount, 10) || 5, 1), 20)
  const templates = [
    {
      q: `Which of the following best defines the primary principle of ${topic} in ${subjectName}?`,
      opts: [
        `It establishes the foundational equilibrium and theoretical framework of ${topic}.`,
        `It represents an obsolete historical hypothesis with limited modern applicability.`,
        `It is exclusively utilized in qualitative observation without measurement.`,
        `It contradicts standard empirical laws governing ${subjectName}.`
      ],
      ans: 'A',
      explanation: `Option A accurately states the primary foundational principle of ${topic}.`
    },
    {
      q: `In the study of ${subjectName}, what is the critical function of ${topic}?`,
      opts: [
        `To eliminate all systematic variables during empirical experimentation.`,
        `To provide structured analytical mechanisms for problem solving and synthesis.`,
        `To invert the natural sequence of theoretical deduction.`,
        `To replace experimental validation with subjective assertions.`
      ],
      ans: 'B',
      explanation: `Option B reflects the standard pedagogical purpose of ${topic}.`
    },
    {
      q: `Which of the following scenarios demonstrates a direct application of ${topic}?`,
      opts: [
        `Analyzing system inputs and outputs to optimize performance and throughput.`,
        `Ignoring baseline measurement data in comparative studies.`,
        `Isolating variables without recording corresponding parameter changes.`,
        `Applying inconsistent calibration metrics across experimental trials.`
      ],
      ans: 'A',
      explanation: `Option A exemplifies the practical application of ${topic} in ${subjectName}.`
    },
    {
      q: `What is the expected outcome when standard rules of ${topic} are violated?`,
      opts: [
        `The system achieves maximum optimal efficiency automatically.`,
        `Anomalies, calculation discrepancies, or structural errors occur in results.`,
        `Experimental precision increases by tenfold.`,
        `Theoretical constraints become permanently irrelevant.`
      ],
      ans: 'B',
      explanation: `Violating principles of ${topic} leads to inconsistencies and calculation errors.`
    },
    {
      q: `Which key factor distinguishes advanced ${topic} from elementary concepts in ${subjectName}?`,
      opts: [
        `The depth of quantitative integration and multi-variable interaction.`,
        `The total absence of mathematical equations and empirical laws.`,
        `The restriction of study to non-verifiable claims only.`,
        `The disregard for evidence-based conclusions.`
      ],
      ans: 'A',
      explanation: `Advanced ${topic} involves multi-variable quantitative interactions and synthesis.`
    },
    {
      q: `How does ${topic} contribute to technological and societal development?`,
      opts: [
        `By enabling scalable problem-solving, automation, and structured decision making.`,
        `By preventing new innovations from emerging in industrial practice.`,
        `By restricting access to scientific knowledge and analytical tools.`,
        `By discouraging rational inquiry and systematic experimentation.`
      ],
      ans: 'A',
      explanation: `Option A highlights the developmental impact of ${topic}.`
    }
  ]

  const generated = []
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length]
    generated.push({
      questionText: `[Q${i + 1}] ${t.q}`,
      questionType: questionType === 'true_false' ? 'true_false' : 'mcq',
      options: questionType === 'true_false' ? ['True', 'False'] : t.opts,
      correctOption: questionType === 'true_false' ? (i % 2 === 0 ? 'A' : 'B') : t.ans,
      marks: 2.0,
      explanation: t.explanation
    })
  }

  return generated
}

/**
 * Auto-grades a student's CBT examination submission.
 * @param {Object} params
 * @param {Array} params.questions - Array of question objects from exam
 * @param {Array} params.studentAnswers - Array of { questionId, answerText }
 * @param {Number} params.passingPercentage - e.g. 50
 */
function autoGradeCbtSubmission({ questions = [], studentAnswers = [], passingPercentage = 50 }) {
  let totalScore = 0
  let totalPossible = 0
  let correctCount = 0
  let wrongCount = 0
  let unansweredCount = 0

  const answersMap = {}
  if (Array.isArray(studentAnswers)) {
    studentAnswers.forEach(ans => {
      const qId = ans.questionId !== undefined ? ans.questionId : ans.id
      answersMap[qId] = String(ans.answerText || ans.answer || '').trim()
    })
  }

  const questionBreakdown = questions.map((q, idx) => {
    const qId = q.id !== undefined ? q.id : idx
    const qMark = Number(q.marks || q.points || 1.0)
    totalPossible += qMark

    const studentAns = answersMap[qId] || ''
    const correctAns = String(q.correctOption || q.correctAnswer || 'A').trim().toUpperCase()

    let isCorrect = false
    if (!studentAns) {
      unansweredCount++
    } else {
      // Compare by letter option (A, B, C, D)
      const cleanStudentAns = studentAns.toUpperCase()
      if (cleanStudentAns === correctAns) {
        isCorrect = true
      } else if (Array.isArray(q.options)) {
        // Also compare by option text or index
        const correctOptText = q.options[correctAns.charCodeAt(0) - 65]
        if (correctOptText && String(correctOptText).trim().toLowerCase() === studentAns.toLowerCase()) {
          isCorrect = true
        }
      }

      if (isCorrect) {
        correctCount++
        totalScore += qMark
      } else {
        wrongCount++
      }
    }

    return {
      questionId: qId,
      questionText: q.questionText || `Question ${idx + 1}`,
      studentAnswer: studentAns || 'Unanswered',
      correctAnswer: correctAns,
      isCorrect,
      marksAwarded: isCorrect ? qMark : 0,
      marksPossible: qMark
    }
  })

  const percentage = totalPossible > 0 ? (totalScore / totalPossible) * 100 : 0
  const isPassed = percentage >= passingPercentage

  let gradeLetter = 'F'
  if (percentage >= 80) gradeLetter = 'A'
  else if (percentage >= 70) gradeLetter = 'B'
  else if (percentage >= 60) gradeLetter = 'C'
  else if (percentage >= 50) gradeLetter = 'D'
  else if (percentage >= 40) gradeLetter = 'E'

  return {
    totalScore: Math.round(totalScore * 100) / 100,
    totalPossible: Math.round(totalPossible * 100) / 100,
    percentage: Math.round(percentage * 10) / 10,
    grade: gradeLetter,
    isPassed,
    correctCount,
    wrongCount,
    unansweredCount,
    totalQuestions: questions.length,
    breakdown: questionBreakdown
  }
}

module.exports = {
  parseAikenFormat,
  parseCsvFormat,
  parseJsonFormat,
  generateAiCurriculumQuestions,
  autoGradeCbtSubmission
}
