import { getDeepseekClient } from './aiClient';

function getOpenAiClient() {
  return getDeepseekClient();
}

export interface LessonPlanParams {
  subjectName?: string;
  className?: string;
  topic?: string;
  subTopic?: string;
  duration?: string;
  curriculumStandard?: string;
  weekNo?: string;
  instruction?: string;
  sourceMaterial?: string;
}

/**
 * Generates structured lesson plan content
 */
export async function generatePedagogicalLessonPlan(params: LessonPlanParams): Promise<any> {
  const {
    subjectName = 'Basic Science',
    className = 'JSS 1',
    topic = 'Living Things and Non-Living Things',
    subTopic = 'Characteristics and Classification',
    duration = '45 Minutes',
    curriculumStandard = 'Nigerian National Curriculum (NERDC / WAEC)',
    weekNo = 'Week 3',
    instruction = '',
    sourceMaterial = '',
  } = params;

  const client = getOpenAiClient();

  if (client) {
    try {
      const systemPrompt = `You are a distinguished Senior Curriculum Master and Pedagogical Inspector adhering strictly to ${curriculumStandard}. Follow the teacher's custom instructions when they conflict with a generic template. Use uploaded or scanned source material as the primary content basis when provided. Return a detailed lesson plan in valid JSON.`;

      const userPrompt = `
Generate a comprehensive, ready-to-teach Lesson Plan for:
- Subject: ${subjectName}
- Class/Grade Level: ${className}
- Main Topic: ${topic}
- Sub-Topic: ${subTopic}
- Duration: ${duration}
- Term Timing: ${weekNo}

Teacher / Admin instructions (must follow):
${instruction?.trim() || 'Create a complete classroom-ready lesson note with objectives, materials, procedure, evaluation, and homework.'}

${sourceMaterial?.trim() ? `Uploaded / scanned teaching material (treat as source of truth; extract, reorganize, and expand — do not ignore it):\n${sourceMaterial.trim().slice(0, 12000)}` : 'No source file was uploaded. Generate from the topic and instructions only.'}

The JSON MUST have the following structure:
{
  "coreTopic": "${topic} - ${subTopic}",
  "educationalObjectives": "Numbered Bloom's taxonomy objectives (Cognitive, Affective, Psychomotor).",
  "materialLists": "Itemized list of instructional materials.",
  "entryBehavior": "Prerequisite knowledge pupils are assumed to already know.",
  "teachingGuide": "Step-by-step instructional sequence with time allocations.",
  "assessmentCriteria": "Formative evaluation rubric and in-class quiz questions.",
  "classAssignments": "Take-home assignment and extension challenge."
}
`;

      const completion = await client.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.55,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(completion.choices[0].message.content || '{}');
      if (parsed && parsed.educationalObjectives && parsed.teachingGuide) {
        return {
          coreTopic: parsed.coreTopic || `${topic} (${subTopic})`,
          educationalObjectives: parsed.educationalObjectives,
          materialLists: parsed.materialLists,
          entryBehavior:
            parsed.entryBehavior ||
            `Pupils have observed everyday examples of ${topic} in their home and school environment.`,
          teachingGuide: parsed.teachingGuide,
          assessmentCriteria: parsed.assessmentCriteria,
          classAssignments: parsed.classAssignments,
        };
      }
    } catch (err: any) {
      console.warn('[LessonPlanService] DeepSeek generation fallback triggered:', err.message);
    }
  }

  // Fallback Curriculum Engine
  return generatePedagogicalFallback({
    subjectName,
    className,
    topic,
    subTopic,
    duration,
    weekNo,
    instruction,
    sourceMaterial,
  });
}

/**
 * High-quality pedagogical fallback generator
 */
export function generatePedagogicalFallback(params: {
  subjectName: string;
  className: string;
  topic?: string;
  subTopic?: string;
  duration: string;
  weekNo?: string;
  instruction?: string;
  sourceMaterial?: string;
}) {
  const { subjectName, className, topic = 'Topic', subTopic = '', duration, instruction = '', sourceMaterial = '' } = params;
  const instructionNote = instruction.trim()
    ? `\nTeacher instruction honoured: ${instruction.trim().slice(0, 800)}`
    : '';
  const sourceNote = sourceMaterial.trim()
    ? `\nDrawn from uploaded/scanned material (${sourceMaterial.trim().slice(0, 400)}…).`
    : '';

  const objectives = `By the end of this ${duration} lesson, pupils should be able to:
1. Cognitive Mastery: Define and explain the foundational concepts of "${topic}" with specific reference to ${subTopic}.${instructionNote}${sourceNote}
2. Analytical Application: Differentiate between key components and practical applications of ${topic} in real-world scenarios.
3. Psychomotor / Affective Skill: Demonstrate active participation by correctly solving guided illustrative exercises and collaborating respectfully in group learning.`;

  const materials = `1. Whiteboard markers, instructional charts, and visual illustrative diagrams for ${topic}.
2. Standard Core Textbooks (Approved Curriculum Edition).
3. Physical demonstrative specimens/props and interactive worksheets.
4. Digital projector or multimedia slides (if ICT lab is utilized).`;

  const entryBehavior = `Pupils are familiar with basic introductory concepts of ${subjectName} from previous lessons and have encountered everyday observations relating to ${topic}.`;

  const teachingGuide = `STEP-BY-STEP INSTRUCTIONAL PROCEDURE (${duration}):

• STEP 1: SET INDUCTION & MOTIVATIONAL HOOK (5 Minutes)
  - Teacher poses an engaging real-world thought-starter: "Have you ever observed how ${topic} impacts our daily environment?"
  - Teacher prompts 2–3 pupils to share prior experiences and links responses to today's topic.

• STEP 2: CONCEPT EXPLORATION & TEACHER PRESENTATION (15 Minutes)
  - Teacher presents the core principles of "${topic}", emphasizing ${subTopic}.
  - Teacher breaks down technical terminologies with clear blackboard illustrations and visual charts.
  - Teacher works through 2 comprehensive worked examples step-by-step.

• STEP 3: GUIDED PRACTICE & ACTIVE PUPIL ENGAGEMENT (10 Minutes)
  - Pupils are paired into collaborative study pods to examine a guided problem set.
  - Teacher circulates the classroom, providing differentiated support and immediate feedback.

• STEP 4: CLASS DISCUSSION & FORMATIVE Q&A (5 Minutes)
  - Teacher invites volunteer pupils to present their findings on the whiteboard.
  - Teacher addresses common misconceptions and reinforces accurate methodologies.

• STEP 5: LESSON SUMMARY & EVALUATION (5 Minutes)
  - Teacher summarizes the 3 core takeaways of ${topic}.
  - Pupils note down key summary points in their subject notebooks.

• STEP 6: CONCLUSION & ASSIGNMENT BRIEFING (5 Minutes)
  - Teacher administers a rapid 3-question formative oral drill and announces the homework task.`;

  const assessmentCriteria = `FORMATIVE EVALUATION & RUBRIC:
1. Oral Diagnostic Questions:
   a. "What is the primary function or definition of ${topic}?"
   b. "How does ${subTopic} apply to practical situations in ${subjectName}?"
2. In-Class Exercise: Completion of Guided Practice Worksheet (Rubric: Accuracy 60%, Methodology 20%, Presentation 20%).
3. Behavioral Observation: Classroom attentiveness, note-taking discipline, and active inquiry.`;

  const classAssignments = `HOMEWORK & EXTENSION ACTIVITY:
1. Standard Assignment: Answer Questions 1 through 5 on Page 42 of the ${subjectName} Workbook.
2. Research Challenge: Identify and write a short 5-line paragraph describing one modern technological or environmental application of ${topic} in Nigeria.`;

  return {
    coreTopic: subTopic ? `${topic} - ${subTopic}` : topic,
    educationalObjectives: objectives,
    materialLists: materials,
    entryBehavior,
    teachingGuide,
    assessmentCriteria,
    classAssignments,
  };
}

export default {
  generatePedagogicalLessonPlan,
  generatePedagogicalFallback,
};
