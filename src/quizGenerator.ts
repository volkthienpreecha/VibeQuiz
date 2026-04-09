import { QuestionType, QuizContext, QuizQuestion } from './types';

interface QuestionBlueprint {
  type: QuestionType;
  prompt: string;
}

export function generateQuizQuestions(context: QuizContext): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  const target = context.symbolName
    ? `\`${context.symbolName}\``
    : context.focusKind === 'selection'
      ? 'this selected block'
      : `\`${context.fileName}\``;

  const addQuestion = (blueprint: QuestionBlueprint): void => {
    if (questions.length >= 3 || questions.some((question) => question.type === blueprint.type)) {
      return;
    }

    questions.push({
      id: `${blueprint.type}-${questions.length + 1}`,
      type: blueprint.type,
      prompt: blueprint.prompt,
      target,
    });
  };

  if (context.symbolName) {
    addQuestion({
      type: 'purpose',
      prompt: `What responsibility does \`${context.symbolName}\` own in ${context.fileName}?`,
    });
    addQuestion({
      type: 'guarantee',
      prompt: `What does \`${context.symbolName}\` guarantee after it runs successfully?`,
    });
  } else if (context.focusKind === 'selection') {
    addQuestion({
      type: 'purpose',
      prompt: `What is this selected block trying to accomplish inside ${context.fileName}?`,
    });
  } else {
    addQuestion({
      type: 'purpose',
      prompt: `What responsibility does ${context.fileName} appear to own?`,
    });
  }

  if (context.hasValidation) {
    addQuestion({
      type: 'designDecision',
      prompt: `Why might the validation or guard logic around ${target} be necessary?`,
    });
  }

  if (context.hasConditionals) {
    addQuestion({
      type: 'failureMode',
      prompt: `What could break if the main conditional path around ${target} is removed?`,
    });
  }

  if (context.hasStateMutation) {
    addQuestion({
      type: 'stateChange',
      prompt: `What state change or side effect happens around ${target}?`,
    });
  }

  if ((context.exports.length > 0 || context.imports.length > 0) && questions.length < 3) {
    addQuestion({
      type: 'dependency',
      prompt: `Which caller, screen, or module is most likely to depend on ${target}?`,
    });
  }

  if (context.hasErrorHandling && questions.length < 3) {
    addQuestion({
      type: 'edgeCase',
      prompt: `What error path or edge case is ${target} trying to protect against?`,
    });
  }

  if (context.hasAsync && questions.length < 3) {
    addQuestion({
      type: 'dependency',
      prompt: `What upstream code is probably waiting on ${target} to finish, and why?`,
    });
  }

  if (questions.length < 3 && context.candidateFunctions.length > 0) {
    addQuestion({
      type: 'guarantee',
      prompt: `What does \`${context.candidateFunctions[0]}\` need to guarantee to the rest of this file?`,
    });
  }

  const fallbacks: QuestionBlueprint[] = [
    {
      type: 'dependency',
      prompt: 'Which part of the system likely depends on this code path?',
    },
    {
      type: 'edgeCase',
      prompt: 'What input case is this code most likely trying to protect against?',
    },
    {
      type: 'failureMode',
      prompt: 'If you changed the core logic here too aggressively, what would you test first?',
    },
    {
      type: 'stateChange',
      prompt: 'After this code runs, what state, output, or side effect should be different?',
    },
  ];

  for (const fallback of fallbacks) {
    addQuestion(fallback);
    if (questions.length === 3) {
      break;
    }
  }

  return questions.slice(0, 3);
}
