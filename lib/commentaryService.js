/**
 * Qualitative Report Card Commentary Generation Service
 * 
 * Generates personalized, constructive, and actionable teacher and principal remarks
 * based on student academic scores, attendance percentages, historical averages, and behavioral traits.
 */

const OpenAI = require('openai')

let openaiClient = null
function getOpenAiClient() {
  if (!openaiClient && process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== 'your_deepseek_api_key_here') {
    try {
      openaiClient = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY
      })
    } catch (e) {
      console.warn('[CommentaryService] Could not initialize DeepSeek client:', e.message)
    }
  }
  return openaiClient
}

/**
 * Generates AI commentary for a single student
 */
async function generateStudentAiCommentary(params) {
  const {
    studentName = 'Student',
    gender = 'Student',
    averageScore = 75,
    attendanceRate = 95,
    marksBySubject = {},
    historicalAverages = '',
    behavioralTags = [],
    tone = 'constructive' // 'constructive', 'rigorous', 'encouraging', 'balanced'
  } = params

  const client = getOpenAiClient()

  // Identify strengths and improvement subjects
  const subjectEntries = Object.entries(marksBySubject || {})
  const strongSubjects = subjectEntries.filter(([, s]) => Number(s) >= 70).map(([k]) => k)
  const weakSubjects = subjectEntries.filter(([, s]) => Number(s) < 50).map(([k]) => k)
  const lowestSubject = subjectEntries.length > 0
    ? subjectEntries.sort((a, b) => Number(a[1]) - Number(b[1]))[0][0]
    : null

  if (client) {
    try {
      const systemPrompt = `You are an expert pedagogical assessor and school principal writing holistic end-of-term report card comments. Return a single cohesive, constructive narrative paragraph (max 80 words) in valid JSON format: {"commentary": "..."}.`

      const userPrompt = `
Write a personalized report card remark for:
- Student Name: ${studentName}
- Term Average: ${averageScore}%
- Subject Scores: ${JSON.stringify(marksBySubject)}
- Key Strengths: ${strongSubjects.join(', ') || 'Consistent performance'}
- Needs Focus: ${weakSubjects.join(', ') || lowestSubject || 'None'}
- Attendance Rate: ${attendanceRate}%
- Behavioral Traits: ${behavioralTags.join(', ') || 'Courteous and attentive'}
- Desired Tone: ${tone}

Rules:
1. Speak warmly and constructively about the pupil's progress.
2. Commend their academic strengths while providing specific, actionable guidance for subjects needing attention.
3. Positively acknowledge attendance or encourage punctuality if under 85%.
4. Keep the remark under 80 words.
`

      const completion = await client.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.15,
        response_format: { type: 'json_object' }
      })

      const parsed = JSON.parse(completion.choices[0].message.content)
      if (parsed && parsed.commentary) {
        return parsed.commentary.trim()
      }
    } catch (err) {
      console.warn('[CommentaryService] DeepSeek call fallback triggered:', err.message)
    }
  }

  // High-Quality Pedagogical Narrative Rule Engine Fallback
  return generatePedagogicalCommentaryFallback({
    studentName,
    averageScore,
    attendanceRate,
    strongSubjects,
    weakSubjects,
    lowestSubject,
    behavioralTags,
    tone
  })
}

/**
 * High-quality pedagogical narrative generator fallback
 */
function generatePedagogicalCommentaryFallback(params) {
  const {
    studentName,
    averageScore,
    attendanceRate,
    strongSubjects,
    weakSubjects,
    lowestSubject,
    behavioralTags,
    tone
  } = params

  const firstName = studentName.split(' ')[0] || 'The pupil'
  const isHighPerformer = averageScore >= 75
  const isModeratePerformer = averageScore >= 55 && averageScore < 75
  const isNeedsIntervention = averageScore < 55

  let opening = ''
  let academicCore = ''
  let conductAttendance = ''
  let closing = ''

  // 1. Opening
  if (isHighPerformer) {
    opening = `${firstName} has demonstrated outstanding academic dedication and intellectual curiosity this term, securing a commendable average of ${averageScore}%.`
  } else if (isModeratePerformer) {
    opening = `${firstName} has shown steady academic progress and consistent diligence throughout this term, achieving an overall average of ${averageScore}%.`
  } else {
    opening = `${firstName} has put in steady effort this term; however, with structured revision and extra classroom focus, substantial improvement is well within reach.`
  }

  // 2. Academic Strengths & Focus Areas
  if (strongSubjects.length > 0) {
    academicCore = `Particular commendation is due for exemplary mastery in ${strongSubjects.slice(0, 2).join(' and ')}.`
  } else {
    academicCore = `Work across curriculum areas has been steady and receptive to guidance.`
  }

  if (weakSubjects.length > 0) {
    academicCore += ` Dedicated revision and extra practice in ${weakSubjects.slice(0, 2).join(' and ')} will further elevate future academic outcomes.`
  } else if (lowestSubject) {
    academicCore += ` Continuous practice in ${lowestSubject} is encouraged to maintain balanced excellence.`
  }

  // 3. Behavioral traits & Attendance
  const traits = behavioralTags.length > 0 ? behavioralTags.slice(0, 2).join(' and ') : 'courteous and well-behaved'
  conductAttendance = `In class, ${firstName} remains ${traits}.`
  if (attendanceRate < 80) {
    conductAttendance += ` More consistent daily attendance (${attendanceRate}%) will bolster academic continuity.`
  }

  // 4. Closing Recommendation
  if (isHighPerformer) {
    closing = `Keep up the brilliant standard of excellence next term!`
  } else if (isModeratePerformer) {
    closing = `A very encouraging performance with strong potential for distinction.`
  } else {
    closing = `With targeted holiday revision and active class participation, higher grades will surely follow.`
  }

  return `${opening} ${academicCore} ${conductAttendance} ${closing}`.replace(/\s+/g, ' ').trim()
}

/**
 * Batch Generates AI Commentary for a Classroom Roster
 * 
 * @param {Array<object>} studentsList
 * @param {string} [tone]
 * @returns {Promise<Array<object>>}
 */
async function generateBatchClassCommentary(studentsList, tone = 'constructive') {
  const results = []

  for (const st of studentsList) {
    const remark = await generateStudentAiCommentary({
      studentName: st.studentName || `${st.firstName} ${st.lastName}`,
      averageScore: Number(st.averageScore) || 70,
      attendanceRate: Number(st.attendanceRate) || 95,
      marksBySubject: st.marksBySubject || {},
      behavioralTags: st.behavioralTags || ['Diligent', 'Courteous'],
      tone
    })

    results.push({
      studentId: st.studentId || st.id,
      studentName: st.studentName || `${st.firstName} ${st.lastName}`,
      registerNo: st.registerNo || '',
      averageScore: st.averageScore || 0,
      attendanceRate: st.attendanceRate || 100,
      generatedRemark: remark,
      status: 'TEACHER_APPROVED'
    })
  }

  return results
}

module.exports = {
  generateStudentAiCommentary,
  generatePedagogicalCommentaryFallback,
  generateBatchClassCommentary
}
