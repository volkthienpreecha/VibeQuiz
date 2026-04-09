import { QuizQuestion, QuizResultSummary, ReflectionItem } from './types';

export function generateReflection(
  questions: QuizQuestion[],
  answers: Record<string, string>,
): { feedback: ReflectionItem[]; weakAreas: string[]; summary: QuizResultSummary } {
  const feedback: ReflectionItem[] = [];
  const weakAreas = new Set<string>();
  let correct = 0;
  let skipped = 0;

  for (const question of questions) {
    const answer = (answers[question.id] ?? '').trim().toLowerCase();
    const correctOption = question.options.find((option) => option.id === question.correctOptionId);
    const selectedOption = question.options.find((option) => option.id === answer);

    if (!correctOption) {
      continue;
    }

    if (!selectedOption) {
      skipped += 1;
      const weakArea = weakAreaFor(question.type);
      weakAreas.add(weakArea);
      feedback.push({
        questionId: question.id,
        headline: 'Skipped question',
        body: `Best answer: ${correctOption.id.toUpperCase()}. ${correctOption.text} ${question.explanation}`,
        weakArea,
        tone: 'warning',
      });
      continue;
    }

    if (selectedOption.id === question.correctOptionId) {
      correct += 1;
      feedback.push({
        questionId: question.id,
        headline: 'Correct read',
        body: question.explanation,
        tone: 'positive',
      });
      continue;
    }

    const weakArea = weakAreaFor(question.type);
    weakAreas.add(weakArea);
    feedback.push({
      questionId: question.id,
      headline: 'Not quite',
      body: `You picked ${selectedOption.id.toUpperCase()}. The stronger answer was ${correctOption.id.toUpperCase()}: ${correctOption.text} ${question.explanation}`,
      weakArea,
      tone: 'warning',
    });
  }

  return {
    feedback,
    weakAreas: Array.from(weakAreas).slice(0, 5),
    summary: {
      correct,
      total: questions.length,
      skipped,
    },
  };
}

function weakAreaFor(type: QuizQuestion['type']): string {
  switch (type) {
    case 'guarantee':
      return 'guarantees';
    case 'dependency':
      return 'dependencies';
    case 'failureMode':
      return 'failure-modes';
    case 'designDecision':
      return 'design-decisions';
    case 'stateChange':
      return 'state-changes';
    case 'edgeCase':
      return 'edge-cases';
    case 'purpose':
    default:
      return 'code-purpose';
  }
}
