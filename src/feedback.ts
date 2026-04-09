import { QuizQuestion, ReflectionItem } from './types';

const KEYWORDS = {
  purpose: ['purpose', 'responsibility', 'handles', 'manages', 'builds', 'creates', 'returns'],
  guarantee: ['guarantee', 'ensures', 'returns', 'return', 'throws', 'updates', 'sets', 'creates'],
  dependency: ['caller', 'callers', 'component', 'screen', 'route', 'service', 'consumer', 'module', 'used by', 'depends'],
  failureMode: ['break', 'broken', 'error', 'regression', 'fail', 'invalid', 'null', 'undefined'],
  designDecision: ['validate', 'guard', 'check', 'prevent', 'protect', 'sanitize', 'invalid'],
  stateChange: ['state', 'update', 'set', 'write', 'persist', 'save', 'dispatch', 'mutate', 'cache'],
  edgeCase: ['edge', 'case', 'empty', 'missing', 'null', 'undefined', 'invalid', 'fallback', 'error'],
} as const;

export function generateReflection(
  questions: QuizQuestion[],
  answers: Record<string, string>,
): { feedback: ReflectionItem[]; weakAreas: string[] } {
  const feedback: ReflectionItem[] = [];
  const weakAreas = new Set<string>();

  for (const question of questions) {
    const answer = (answers[question.id] ?? '').trim();
    const wordCount = countWords(answer);
    const normalized = answer.toLowerCase();

    if (!answer) {
      const weakArea = weakAreaFor(question.type);
      weakAreas.add(weakArea);
      feedback.push({
        questionId: question.id,
        headline: 'Skipped answer detected',
        body: 'Skipped questions usually point to the part of the code you trust least. That is a useful signal.',
        weakArea,
        tone: 'warning',
      });
      continue;
    }

    if (wordCount < 7) {
      const weakArea = weakAreaFor(question.type);
      weakAreas.add(weakArea);
      feedback.push({
        questionId: question.id,
        headline: 'Answer is still thin',
        body: 'You have the start of an explanation. Push it one step further with a concrete behavior, downstream effect, or failure path.',
        weakArea,
        tone: 'warning',
      });
      continue;
    }

    if (!containsAny(normalized, KEYWORDS[question.type])) {
      const weakArea = weakAreaFor(question.type);
      weakAreas.add(weakArea);
      feedback.push(buildWeakSignalFeedback(question.id, question.type, weakArea));
      continue;
    }

    feedback.push(buildPositiveFeedback(question.id, question.type));
  }

  return {
    feedback,
    weakAreas: Array.from(weakAreas).slice(0, 4),
  };
}

function buildWeakSignalFeedback(
  questionId: string,
  type: QuizQuestion['type'],
  weakArea: string,
): ReflectionItem {
  switch (type) {
    case 'dependency':
      return {
        questionId,
        headline: 'You stayed local',
        body: 'You explained the logic, but not who probably calls it or relies on it. Name the likely consumer next time.',
        weakArea,
        tone: 'neutral',
      };
    case 'guarantee':
      return {
        questionId,
        headline: 'Intent is clearer than outcome',
        body: 'Try to separate what the code wants to do from what it actually guarantees after execution.',
        weakArea,
        tone: 'neutral',
      };
    case 'failureMode':
    case 'edgeCase':
      return {
        questionId,
        headline: 'Edge-case reasoning is still soft',
        body: 'You described the happy path more than the breakage path. Call out the concrete bad input or regression risk.',
        weakArea,
        tone: 'neutral',
      };
    case 'stateChange':
      return {
        questionId,
        headline: 'Missing the actual delta',
        body: 'Name what changes after the code runs: state, storage, cache, output, or UI.',
        weakArea,
        tone: 'neutral',
      };
    case 'designDecision':
      return {
        questionId,
        headline: 'The protection is vague',
        body: 'You spotted the guard, but not the concrete bad state it is preventing.',
        weakArea,
        tone: 'neutral',
      };
    case 'purpose':
    default:
      return {
        questionId,
        headline: 'Purpose needs more shape',
        body: 'You have the gist. Tighten it into one clear responsibility statement instead of a general description.',
        weakArea,
        tone: 'neutral',
      };
  }
}

function buildPositiveFeedback(questionId: string, type: QuizQuestion['type']): ReflectionItem {
  switch (type) {
    case 'dependency':
      return {
        questionId,
        headline: 'Fair dependency read',
        body: 'You identified likely downstream callers, which is usually where real understanding starts to show up.',
        tone: 'positive',
      };
    case 'guarantee':
      return {
        questionId,
        headline: 'You described the contract',
        body: 'Good. You focused on what the code must leave true afterward, not just its high-level purpose.',
        tone: 'positive',
      };
    case 'failureMode':
    case 'edgeCase':
      return {
        questionId,
        headline: 'Failure path acknowledged',
        body: 'You called out the thing that would go wrong, which is usually the part people skip when they only half-understand a change.',
        tone: 'positive',
      };
    case 'stateChange':
      return {
        questionId,
        headline: 'State change is concrete',
        body: 'You named the observable delta after execution, which keeps the answer anchored to behavior instead of vibes.',
        tone: 'positive',
      };
    case 'designDecision':
      return {
        questionId,
        headline: 'Reasonable design read',
        body: 'You connected the guard to the risk it is trying to avoid. That is the right level of explanation.',
        tone: 'positive',
      };
    case 'purpose':
    default:
      return {
        questionId,
        headline: 'Clear purpose statement',
        body: 'You described what this code is for in a way another engineer could probably reuse during review or handoff.',
        tone: 'positive',
      };
  }
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

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}
