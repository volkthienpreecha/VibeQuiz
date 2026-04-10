import { ChangeChunk, QuestionType, QuizContext, QuizOptionId, QuizQuestion } from './types';

interface QuestionBlueprint {
  type: QuestionType;
  prompt: string;
  correctText: string;
  distractors: string[];
  explanation: string;
}

const OPTION_IDS: QuizOptionId[] = ['a', 'b', 'c', 'd'];

export function generateQuizQuestions(context: QuizContext): QuizQuestion[] {
  if (context.isChunkedSession && context.changeChunks && context.changeChunks.length > 0) {
    return generateChunkedQuizQuestions(context);
  }

  const questions: QuizQuestion[] = [];
  const target = getTargetLabel(context);

  const addQuestion = (blueprint: QuestionBlueprint): void => {
    if (questions.length >= 5 || questions.some((question) => question.type === blueprint.type)) {
      return;
    }

    questions.push(createQuestion(blueprint, questions.length + 1, target));
  };

  addQuestion(buildPurposeQuestion(context, target));

  if (context.changeContext) {
    addQuestion(buildChangeQuestion(context, target));
  }

  addQuestion(buildGuaranteeQuestion(context, target));

  if (context.hasValidation) {
    addQuestion(buildDesignQuestion(context, target));
  }

  if (context.hasConditionals || context.changeContext) {
    addQuestion(buildFailureModeQuestion(context, target));
  }

  if (context.imports.length > 0 || context.exports.length > 0 || context.candidateFunctions.length > 0) {
    addQuestion(buildDependencyQuestion(context, target));
  }

  if (context.hasStateMutation || context.hasAsync) {
    addQuestion(buildStateQuestion(context, target));
  }

  if (context.hasErrorHandling || context.hasValidation || context.hasConditionals) {
    addQuestion(buildEdgeCaseQuestion(context, target));
  }

  const fallbacks = [
    buildDependencyQuestion(context, target),
    buildStateQuestion(context, target),
    buildEdgeCaseQuestion(context, target),
    buildDesignQuestion(context, target),
    buildFailureModeQuestion(context, target),
    buildGuaranteeQuestion(context, target),
  ];

  for (const fallback of fallbacks) {
    addQuestion(fallback);
    if (questions.length === 5) {
      break;
    }
  }

  return questions.slice(0, 5);
}

function generateChunkedQuizQuestions(context: QuizContext): QuizQuestion[] {
  const chunks = (context.changeChunks ?? []).slice(0, 4);
  const questions: QuizQuestion[] = [];
  let position = 1;

  for (const chunk of chunks) {
    if (questions.length >= 5) {
      break;
    }

    const chunkContext = buildChunkContext(context, chunk);
    const target = getChunkTargetLabel(chunk);
    questions.push(createQuestion(buildPurposeQuestion(chunkContext, target), position, target, chunk));
    position += 1;
  }

  const secondaryBuilders = chunks.map((chunk) => ({
    chunk,
    builder: selectSecondaryBuilder(buildChunkContext(context, chunk)),
  }));

  for (const item of secondaryBuilders) {
    if (questions.length >= 5) {
      break;
    }

    const chunkContext = buildChunkContext(context, item.chunk);
    const target = getChunkTargetLabel(item.chunk);
    questions.push(createQuestion(item.builder(chunkContext, target), position, target, item.chunk));
    position += 1;
  }

  const fallbackBuilders = [
    buildDependencyQuestion,
    buildGuaranteeQuestion,
    buildDesignQuestion,
    buildEdgeCaseQuestion,
    buildStateQuestion,
  ];

  for (const builder of fallbackBuilders) {
    if (questions.length >= 5 || chunks.length === 0) {
      break;
    }

    const topChunk = chunks[0];
    const chunkContext = buildChunkContext(context, topChunk);
    const target = getChunkTargetLabel(topChunk);
    questions.push(createQuestion(builder(chunkContext, target), position, target, topChunk));
    position += 1;
  }

  return questions.slice(0, 5);
}

function buildPurposeQuestion(context: QuizContext, target: string): QuestionBlueprint {
  if (context.changeContext) {
    const changeType = context.changeContext.type;
    const correctText =
      changeType === 'added'
        ? 'Introduce a new behavior or path in the focused code.'
        : changeType === 'removed'
          ? 'Remove an old behavior or branch callers may have depended on.'
          : 'Change the behavior or contract of an existing path.';

    return {
      type: 'purpose',
      prompt: `What is the best read of what changed in ${target}?`,
      correctText,
      distractors: [
        'Only rename variables without affecting behavior.',
        'Configure the whole repository for a new runtime.',
        'Move every caller to a different module automatically.',
      ],
      explanation: 'The strongest answer names the local behavioral change, not a repo-wide fantasy or a formatting-only story.',
    };
  }

  const correctText = context.symbolName
    ? `Own the behavior centered on ${context.symbolName} inside ${context.fileName}.`
    : context.focusKind === 'selection'
      ? `Handle the selected block inside ${context.fileName}, not the whole app.`
      : `Own a local responsibility inside ${context.fileName}.`;

  return {
    type: 'purpose',
    prompt: `What is the clearest responsibility statement for ${target}?`,
    correctText,
    distractors: [
      'Define team process and project roadmap for the repository.',
      'Configure global cloud analytics for every environment.',
      'Replace all nearby modules with a single shared abstraction.',
    ],
    explanation: 'A good purpose answer stays local to the focused code instead of pretending the file owns the whole system.',
  };
}

function buildChangeQuestion(context: QuizContext, target: string): QuestionBlueprint {
  const changeType = context.changeContext?.type ?? 'modified';
  const correctText =
    changeType === 'added'
      ? 'Verify the new path and the first caller or test that should exercise it.'
      : changeType === 'removed'
        ? 'Verify that no caller or test still expects the removed behavior.'
        : 'Verify the edited branch against the previous behavior and its closest caller.';

  return {
    type: 'designDecision',
    prompt: `After this edit to ${target}, what is the smartest first verification step?`,
    correctText,
    distractors: [
      'Rewrite the entire file before checking any caller.',
      'Assume the diff is correct because the code compiles.',
      'Ignore nearby tests and focus only on formatting changes.',
    ],
    explanation: 'The first verification target should be the changed behavior and the nearest code that relies on it.',
  };
}

function buildGuaranteeQuestion(context: QuizContext, target: string): QuestionBlueprint {
  let correctText = 'Name one concrete postcondition that should hold after this path runs.';
  let explanation = 'The best guarantee is a concrete postcondition, not a vague hope that the code "works."';

  if (context.hasValidation) {
    correctText = 'Invalid or missing input should be blocked before the main path continues.';
    explanation = 'Validation changes the contract by preventing bad state from moving downstream.';
  } else if (context.hasStateMutation) {
    correctText = 'A visible state, output, cache, or stored value should change after execution.';
    explanation = 'When code mutates state, the safest contract is an observable change, not a hand-wavy intention.';
  } else if (context.hasAsync) {
    correctText = 'Callers should expect completion or failure to resolve asynchronously.';
    explanation = 'Async code changes timing assumptions, so the contract is about eventual completion or failure.';
  } else if (context.changeContext?.type === 'removed') {
    correctText = 'Callers can no longer assume the removed behavior still happens here.';
    explanation = 'A removal changes the contract by taking something away that older callers may still expect.';
  }

  return {
    type: 'guarantee',
    prompt: `Which contract assumption is safest for ${target}?`,
    correctText,
    distractors: [
      'Every invocation is guaranteed to succeed no matter the input.',
      'Downstream code never needs tests once this path exists.',
      'Any failure here will fix itself without caller handling.',
    ],
    explanation,
  };
}

function buildDependencyQuestion(context: QuizContext, target: string): QuestionBlueprint {
  const correctText = context.changeContext
    ? `Re-check the nearest callers, imports/exports, or tests that exercise ${target}.`
    : `The nearest callers, modules, or tests touching ${target} are the best dependency read.`;

  return {
    type: 'dependency',
    prompt: `Which dependency read is most useful for understanding ${target}?`,
    correctText,
    distractors: [
      'Anything in the repo with the same file extension is equally likely to depend on it.',
      'Only the editor theme depends on this path.',
      'Nothing else depends on it because source files are isolated by default.',
    ],
    explanation: 'The strongest dependency answer stays close to real callers and tests instead of inventing repo-wide coupling.',
  };
}

function buildFailureModeQuestion(context: QuizContext, target: string): QuestionBlueprint {
  let correctText = 'A caller or test that relies on the edited contract would break first.';
  let explanation = 'The first regression signal is usually the nearest caller that assumed the old behavior.';

  if (context.hasValidation || context.hasErrorHandling) {
    correctText = 'Bad inputs or rejected paths leaking through to downstream logic would break first.';
    explanation = 'When guards or error handling matter, the quickest failure is usually invalid state escaping the boundary.';
  } else if (context.hasConditionals) {
    correctText = 'The wrong branch firing for an edge case would show up first.';
    explanation = 'Conditional logic usually fails by choosing the wrong path for a specific case.';
  } else if (context.changeContext?.type === 'removed') {
    correctText = 'A caller or test still expecting the removed behavior would fail first.';
    explanation = 'Removals break expectations fastest where the old behavior was still assumed.';
  }

  return {
    type: 'failureMode',
    prompt: `If the assumption behind ${target} is wrong, what is the most likely first regression?`,
    correctText,
    distractors: [
      'Whitespace alignment changes without any behavioral impact.',
      'Git history silently rewrites itself after the edit.',
      'The API key store becomes unreadable for unrelated commands.',
    ],
    explanation,
  };
}

function buildDesignQuestion(context: QuizContext, target: string): QuestionBlueprint {
  const correctText = context.hasValidation
    ? 'Prevent invalid state or bad input from flowing deeper into the main path.'
    : context.changeContext
      ? 'Protect the intended contract change instead of accidentally changing unrelated behavior.'
      : 'Keep a local invariant true before other code depends on it.';

  return {
    type: 'designDecision',
    prompt: `Why would a guard, check, or extra branch around ${target} exist at all?`,
    correctText,
    distractors: [
      'To remove the need for tests anywhere else in the project.',
      'To make every caller synchronous no matter how it was written.',
      'To guarantee the entire repository can never throw an error again.',
    ],
    explanation: 'Good defensive logic protects a concrete invariant or boundary. It does not magically eliminate all downstream risk.',
  };
}

function buildStateQuestion(context: QuizContext, target: string): QuestionBlueprint {
  const correctText = context.hasStateMutation
    ? 'Some observable state, output, cache, or persisted value should change after this path runs.'
    : context.hasAsync
      ? 'Callers should be ready for a later result or failure rather than an immediate synchronous assumption.'
      : `The best next read is the caller or test that shows how ${target} changes program behavior.`;

  const explanation = context.hasStateMutation
    ? 'State-oriented code is best understood through its observable delta after execution.'
    : context.hasAsync
      ? 'Async behavior is mostly about timing and failure handling expectations.'
      : 'When mutation is not obvious, the next caller or test usually reveals what behavior actually changes.';

  return {
    type: 'stateChange',
    prompt: `What is the strongest observable-behavior read for ${target}?`,
    correctText,
    distractors: [
      'Nothing observable should change; the path exists only for decoration.',
      'The entire UI theme must update every time this code runs.',
      'Every dependent module becomes independent after execution.',
    ],
    explanation,
  };
}

function buildEdgeCaseQuestion(context: QuizContext, target: string): QuestionBlueprint {
  const correctText = context.hasValidation || context.hasErrorHandling
    ? 'Missing, invalid, or rejected input paths are the best edge cases to test first.'
    : context.hasConditionals
      ? 'A boundary case that flips the main branch is the most useful edge case to test first.'
      : `The closest contract edge case around ${target} is the first thing worth testing.`;

  const explanation = context.hasValidation || context.hasErrorHandling
    ? 'Guards and error paths usually exist because invalid input is a realistic way for this code to fail.'
    : context.hasConditionals
      ? 'When branches matter, the sharpest test is the case that makes the code choose differently.'
      : 'Even without obvious guards, the first meaningful edge case is the boundary where callers could misunderstand the contract.';

  return {
    type: 'edgeCase',
    prompt: `Which test focus is most likely to teach you something real about ${target}?`,
    correctText,
    distractors: [
      'Only happy-path data because edge cases rarely change behavior.',
      'A random file in the repo with unrelated logic.',
      'Whether the editor window was resized before the function ran.',
    ],
    explanation,
  };
}

function createQuestion(
  blueprint: QuestionBlueprint,
  position: number,
  target: string,
  chunk?: Pick<ChangeChunk, 'id' | 'label'>,
): QuizQuestion {
  const normalizedOptions = uniqueOptions(blueprint.correctText, blueprint.distractors);
  const correctIndex = position % OPTION_IDS.length;
  const orderedTexts = [...normalizedOptions];
  orderedTexts.splice(correctIndex, 0, blueprint.correctText);
  const trimmedTexts = orderedTexts.slice(0, OPTION_IDS.length);

  return {
    id: `${blueprint.type}-${position}`,
    type: blueprint.type,
    prompt: blueprint.prompt,
    target,
    chunkId: chunk?.id,
    chunkLabel: chunk?.label,
    options: trimmedTexts.map((text, index) => ({
      id: OPTION_IDS[index],
      text,
    })),
    correctOptionId: OPTION_IDS[correctIndex],
    explanation: blueprint.explanation,
  };
}

function uniqueOptions(correctText: string, distractors: string[]): string[] {
  const unique = Array.from(new Set(distractors.map((item) => item.trim()).filter(Boolean)));
  const filtered = unique.filter((item) => item !== correctText);
  const fallbacks = [
    'It mainly affects code that is unrelated to the focused path.',
    'It is only about formatting and has no behavioral meaning.',
    'It automatically removes the need to inspect callers or tests.',
  ];

  for (const fallback of fallbacks) {
    if (filtered.length >= 3) {
      break;
    }

    if (!filtered.includes(fallback) && fallback !== correctText) {
      filtered.push(fallback);
    }
  }

  return filtered.slice(0, 3);
}

function buildChunkContext(context: QuizContext, chunk: ChangeChunk): QuizContext {
  const analysisText = `${chunk.currentSnippet}\n${chunk.previousSnippet ?? ''}`;

  return {
    ...context,
    focusLabel: chunk.label,
    focusSnippet: chunk.currentSnippet,
    symbolName: chunk.symbolName ?? context.symbolName,
    candidateFunctions: chunk.symbolName ? [chunk.symbolName] : context.candidateFunctions,
    hasConditionals: /\bif\b|\bswitch\b|\?.+:/m.test(analysisText),
    hasValidation: /validate|invalid|required|guard|assert|sanitize|schema|null|undefined|empty|length\s*[<>=]/im.test(analysisText),
    hasAsync: /\basync\b|\bawait\b|Promise\b/im.test(analysisText),
    hasErrorHandling: /\btry\b|\bcatch\b|\bthrow\b|reject\(|console\.error/im.test(analysisText),
    hasStateMutation: /set[A-Z]\w*\(|dispatch\(|push\(|splice\(|assign\(|update[A-Z]\w*\(|save[A-Z]\w*\(|create[A-Z]\w*\(|delete[A-Z]\w*\(/.test(analysisText),
    changeContext: {
      source: context.changeContext?.source ?? 'git-head',
      type: chunk.type,
      label: chunk.label,
      range: chunk.range,
      lineCount: chunk.lineCount,
      currentSnippet: chunk.currentSnippet,
      previousSnippet: chunk.previousSnippet,
    },
    changeChunks: [chunk],
    isChunkedSession: true,
  };
}

function getChunkTargetLabel(chunk: ChangeChunk): string {
  if (chunk.symbolName) {
    return `\`${chunk.symbolName}\` (${chunk.range})`;
  }

  return `${chunk.label} (${chunk.range})`;
}

function selectSecondaryBuilder(
  context: QuizContext,
): (context: QuizContext, target: string) => QuestionBlueprint {
  if (context.hasValidation || context.hasErrorHandling || context.hasConditionals) {
    return buildFailureModeQuestion;
  }

  if (context.hasStateMutation || context.hasAsync) {
    return buildStateQuestion;
  }

  if (context.imports.length > 0 || context.exports.length > 0 || context.candidateFunctions.length > 0) {
    return buildDependencyQuestion;
  }

  return buildGuaranteeQuestion;
}

function getTargetLabel(context: QuizContext): string {
  if (context.symbolName) {
    return `\`${context.symbolName}\``;
  }

  if (context.focusKind === 'selection') {
    return 'this selected block';
  }

  if (context.focusKind === 'change') {
    return 'this edit';
  }

  return `\`${context.fileName}\``;
}
