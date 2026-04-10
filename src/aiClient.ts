import { AiSettings, providerLabel } from './config';
import { QuestionType, QuizContext, QuizQuestion, ReflectionItem } from './types';

interface StructuredOutputRequest {
  settings: AiSettings;
  apiKey: string;
  schemaName: string;
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
}

const OPTION_IDS = ['a', 'b', 'c', 'd'] as const;

interface AiQuestionResponse {
  questions: Array<{
    type: QuestionType;
    prompt: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    chunkId: string | null;
  }>;
}

interface RawAiReflectionResponse {
  feedback: Array<{
    questionId: string;
    headline: string;
    body: string;
    tone: ReflectionItem['tone'];
    weakArea: string | null;
  }>;
  weakAreas: string[];
}

interface AiReflectionResult {
  feedback: ReflectionItem[];
  weakAreas: string[];
}

export async function generateAiQuizQuestions(
  context: QuizContext,
  settings: AiSettings,
  apiKey: string,
): Promise<QuizQuestion[]> {
  const response = await requestStructuredOutput<AiQuestionResponse>({
    settings,
    apiKey,
    schemaName: 'vibequiz_questions',
    instructions: [
      'You are VibeQuiz, a code-recall coach inside VS Code.',
      'Generate exactly 5 short, fair multiple-choice questions about the provided code context.',
      'Ground every question in the visible file context only. Do not invent repo-wide knowledge.',
      'If the context includes a change block, prioritize questions about the edit and its behavioral impact.',
      'If the context includes sessionInfo or multiple changeChunks, treat this as one coding session rather than one isolated function.',
      'Avoid repeating the same purpose question across all chunks. Mix contract, dependency, failure mode, design tradeoff, and edge case questions.',
      'If changeChunks are present, attach each question to the best matching chunkId. Use null only when a question is intentionally cross-chunk.',
      'Avoid trivia, style nitpicks, trick questions, and school-exam tone.',
      'Vary the question types when possible.',
      'Each question must have 4 distinct options and exactly 1 best answer.',
      'Keep prompts concise enough to fit in one or two lines.',
      'Keep the explanation short and practical.',
    ].join(' '),
    input: buildQuizInput(context),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          minItems: 5,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'prompt', 'options', 'correctIndex', 'explanation', 'chunkId'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'purpose',
                  'guarantee',
                  'dependency',
                  'failureMode',
                  'designDecision',
                  'stateChange',
                  'edgeCase',
                ],
              },
              prompt: {
                type: 'string',
                minLength: 12,
                maxLength: 180,
              },
              options: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: {
                  type: 'string',
                  minLength: 6,
                  maxLength: 140,
                },
              },
              correctIndex: {
                type: 'integer',
                minimum: 0,
                maximum: 3,
              },
              explanation: {
                type: 'string',
                minLength: 12,
                maxLength: 220,
              },
              chunkId: {
                anyOf: [
                  {
                    type: 'string',
                    minLength: 3,
                    maxLength: 64,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  const prompts = new Set<string>();
  const chunkById = new Map((context.changeChunks ?? []).map((chunk) => [chunk.id, chunk]));
  const questions = response.questions
    .map((question, index) => ({
      id: `ai-${question.type}-${index + 1}`,
      type: question.type,
      prompt: normalizePrompt(question.prompt),
      chunkId: question.chunkId ?? undefined,
      chunkLabel: question.chunkId ? chunkById.get(question.chunkId)?.label : undefined,
      options: question.options.map((option, optionIndex) => ({
        id: OPTION_IDS[optionIndex],
        text: normalizePrompt(option),
      })),
      correctOptionId: OPTION_IDS[question.correctIndex] ?? 'a',
      explanation: normalizePrompt(question.explanation),
    }))
    .filter((question) => {
      if (prompts.has(question.prompt)) {
        return false;
      }

      prompts.add(question.prompt);
      return true;
    });

  if (questions.length !== 5 || questions.some((question) => question.options.length !== 4)) {
    throw new Error('AI response did not contain five usable multiple-choice questions.');
  }

  return questions;
}

export async function generateAiReflection(
  context: QuizContext,
  questions: QuizQuestion[],
  answers: Record<string, string>,
  settings: AiSettings,
  apiKey: string,
): Promise<AiReflectionResult> {
  const response = await requestStructuredOutput<RawAiReflectionResponse>({
    settings,
    apiKey,
    schemaName: 'vibequiz_reflection',
    instructions: [
      'You are VibeQuiz, a code-recall coach inside VS Code.',
      'Return brief reflection feedback for each answer.',
      'Do not grade correctness with certainty. Call out vague reasoning, missing downstream effects, or solid understanding honestly.',
      'Keep each feedback item to one headline and one short body.',
      'For every feedback item, include weakArea. Use a short kebab-case tag when there is a real gap, otherwise return null.',
      'Return weak-area tags only for real gaps.',
    ].join(' '),
    input: buildReflectionInput(context, questions, answers),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['feedback', 'weakAreas'],
      properties: {
        feedback: {
          type: 'array',
          minItems: questions.length,
          maxItems: questions.length,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['questionId', 'headline', 'body', 'tone', 'weakArea'],
            properties: {
              questionId: {
                type: 'string',
              },
              headline: {
                type: 'string',
                minLength: 3,
                maxLength: 80,
              },
              body: {
                type: 'string',
                minLength: 12,
                maxLength: 220,
              },
              tone: {
                type: 'string',
                enum: ['positive', 'neutral', 'warning'],
              },
              weakArea: {
                anyOf: [
                  {
                    type: 'string',
                    minLength: 3,
                    maxLength: 32,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
          },
        },
        weakAreas: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'string',
            minLength: 3,
            maxLength: 32,
          },
        },
      },
    },
  });

  const feedbackById = new Map(response.feedback.map((item) => [item.questionId, item]));
  const orderedFeedback: ReflectionItem[] = questions.map((question) => {
    const match = feedbackById.get(question.id);
    if (match) {
      return {
        ...match,
        weakArea: match.weakArea ? normalizeWeakArea(match.weakArea) : undefined,
      };
    }

    return {
      questionId: question.id,
      headline: 'Reflection unavailable',
      body: 'The AI response did not include feedback for this answer, so VibeQuiz could not assess it reliably.',
      tone: 'neutral' as const,
    };
  });

  return {
    feedback: orderedFeedback,
    weakAreas: Array.from(new Set(response.weakAreas.map(normalizeWeakArea))).slice(0, 4),
  };
}

async function requestStructuredOutput<T>(request: StructuredOutputRequest): Promise<T> {
  switch (request.settings.provider) {
    case 'anthropic':
      return requestAnthropicStructuredOutput<T>(request);
    case 'gemini':
      return requestGeminiStructuredOutput<T>(request);
    case 'openaiCompatible':
      return requestOpenAiCompatibleStructuredOutput<T>(request);
    case 'openai':
    default:
      return requestOpenAiStructuredOutput<T>(request);
  }
}

async function requestOpenAiStructuredOutput<T>({
  settings,
  apiKey,
  schemaName,
  instructions,
  input,
  schema,
}: StructuredOutputRequest): Promise<T> {
  return withTimeout(settings, async (signal) => {
    const response = await fetch(`${settings.baseUrl}/responses`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        store: false,
        instructions,
        input,
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractProviderError(payload, settings));
    }

    const rawText = extractOpenAiResponseText(payload);
    if (!rawText) {
      throw new Error(`${providerLabel(settings.provider)} returned an empty response.`);
    }

    return parseJsonResponse<T>(rawText, settings);
  });
}

async function requestAnthropicStructuredOutput<T>({
  settings,
  apiKey,
  schemaName,
  instructions,
  input,
  schema,
}: StructuredOutputRequest): Promise<T> {
  return withTimeout(settings, async (signal) => {
    const toolName = sanitizeToolName(schemaName);
    const response = await fetch(`${settings.baseUrl}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': settings.anthropicVersion,
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 1600,
        system: instructions,
        messages: [
          {
            role: 'user',
            content: input,
          },
        ],
        tools: [
          {
            name: toolName,
            description: 'Return the final structured VibeQuiz payload.',
            input_schema: schema,
          },
        ],
        tool_choice: {
          type: 'tool',
          name: toolName,
        },
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractProviderError(payload, settings));
    }

    const content = Array.isArray(payload.content) ? payload.content : [];
    const toolUse = content.find((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }

      const block = item as { type?: string; name?: string };
      return block.type === 'tool_use' && block.name === toolName;
    }) as { input?: unknown } | undefined;

    if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
      throw new Error('Anthropic did not return the structured tool payload VibeQuiz requested.');
    }

    return toolUse.input as T;
  });
}

async function requestGeminiStructuredOutput<T>({
  settings,
  apiKey,
  instructions,
  input,
  schema,
}: StructuredOutputRequest): Promise<T> {
  return withTimeout(settings, async (signal) => {
    const response = await fetch(`${settings.baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${instructions}\n\nReturn only JSON matching the provided schema.\n\n${input}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractProviderError(payload, settings));
    }

    const rawText = extractGeminiText(payload);
    if (!rawText) {
      throw new Error('Gemini returned an empty structured response.');
    }

    return parseJsonResponse<T>(rawText, settings);
  });
}

async function requestOpenAiCompatibleStructuredOutput<T>({
  settings,
  apiKey,
  instructions,
  input,
  schema,
}: StructuredOutputRequest): Promise<T> {
  return withTimeout(settings, async (signal) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: buildJsonOnlyPrompt(instructions, schema),
          },
          {
            role: 'user',
            content: input,
          },
        ],
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractProviderError(payload, settings));
    }

    const rawText = extractOpenAiCompatibleText(payload);
    if (!rawText) {
      throw new Error(`${providerLabel(settings.provider)} returned an empty response.`);
    }

    return parseJsonResponse<T>(extractJsonString(rawText), settings);
  });
}

async function withTimeout<T>(
  settings: AiSettings,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

  try {
    return await task(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${providerLabel(settings.provider)} request timed out after ${settings.timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildQuizInput(context: QuizContext): string {
  return JSON.stringify(
    {
      fileName: context.fileName,
      languageId: context.languageId,
      lineCount: context.lineCount,
      focusLabel: context.focusLabel,
      focusKind: context.focusKind,
      selectionRange: context.selectionRange,
      sessionInfo: context.sessionInfo
        ? {
            id: context.sessionInfo.id,
            startedAt: context.sessionInfo.startedAt,
            endedAt: context.sessionInfo.endedAt,
            workspaceName: context.sessionInfo.workspaceName,
            baseRefLabel: context.sessionInfo.baseRefLabel,
            touchedFileCount: context.sessionInfo.touchedFileCount,
            changedFileCount: context.sessionInfo.changedFileCount,
          }
        : undefined,
      changeContext: context.changeContext
        ? {
            source: context.changeContext.source,
            type: context.changeContext.type,
            range: context.changeContext.range,
            lineCount: context.changeContext.lineCount,
            currentSnippet: context.changeContext.currentSnippet,
            previousSnippet: context.changeContext.previousSnippet,
          }
        : undefined,
      isChunkedSession: context.isChunkedSession,
      changeChunks: context.changeChunks?.slice(0, 4).map((chunk) => ({
        id: chunk.id,
        label: chunk.label,
        symbolName: chunk.symbolName,
        fileName: chunk.fileName,
        languageId: chunk.languageId,
        type: chunk.type,
        range: chunk.range,
        lineCount: chunk.lineCount,
        score: chunk.score,
        reasons: chunk.reasons,
        currentSnippet: chunk.currentSnippet,
        previousSnippet: chunk.previousSnippet,
      })),
      imports: context.imports.slice(0, 5),
      exports: context.exports.slice(0, 5),
      candidateFunctions: context.candidateFunctions.slice(0, 5),
      heuristics: {
        hasConditionals: context.hasConditionals,
        hasValidation: context.hasValidation,
        hasAsync: context.hasAsync,
        hasErrorHandling: context.hasErrorHandling,
        hasStateMutation: context.hasStateMutation,
      },
      focusSnippet: context.focusSnippet,
    },
    null,
    2,
  );
}

function buildReflectionInput(
  context: QuizContext,
  questions: QuizQuestion[],
  answers: Record<string, string>,
): string {
  return JSON.stringify(
    {
      fileName: context.fileName,
      focusLabel: context.focusLabel,
      focusSnippet: context.focusSnippet,
      questions: questions.map((question) => ({
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        answer: answers[question.id] ?? '',
      })),
    },
    null,
    2,
  );
}

function extractProviderError(payload: Record<string, unknown>, settings: AiSettings): string {
  const error = payload.error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return `${providerLabel(settings.provider)} returned an unexpected error.`;
}

function extractOpenAiResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const fragments: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? ((item as { content: unknown[] }).content as unknown[])
      : [];

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      const typedBlock = block as {
        text?: string;
        output_text?: string;
      };

      if (typeof typedBlock.text === 'string' && typedBlock.text.trim()) {
        fragments.push(typedBlock.text.trim());
      }

      if (typeof typedBlock.output_text === 'string' && typedBlock.output_text.trim()) {
        fragments.push(typedBlock.output_text.trim());
      }
    }
  }

  return fragments.join('\n').trim();
}

function extractGeminiText(payload: Record<string, unknown>): string {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0];
  if (!firstCandidate || typeof firstCandidate !== 'object') {
    return '';
  }

  const content = (firstCandidate as { content?: unknown }).content;
  if (!content || typeof content !== 'object') {
    return '';
  }

  const parts = Array.isArray((content as { parts?: unknown[] }).parts)
    ? ((content as { parts: unknown[] }).parts as unknown[])
    : [];

  const textParts = parts
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean);

  return textParts.join('\n').trim();
}

function extractOpenAiCompatibleText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') {
    return '';
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    return '';
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildJsonOnlyPrompt(instructions: string, schema: Record<string, unknown>): string {
  return [
    instructions,
    'Return only valid JSON.',
    'Do not include markdown fences, commentary, or prose before or after the JSON.',
    `Follow this JSON schema exactly:\n${JSON.stringify(schema, null, 2)}`,
  ].join('\n\n');
}

function parseJsonResponse<T>(rawText: string, settings: AiSettings): T {
  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(`${providerLabel(settings.provider)} returned malformed JSON.`);
  }
}

function extractJsonString(value: string): string {
  const trimmed = value.trim();

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Model response did not contain a parseable JSON object.');
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'vibequiz_output';
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}

function normalizeWeakArea(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
