export interface QuizContext {
  fileName: string;
  filePath: string;
  languageId: string;
  lineCount: number;
  selectionText?: string;
  selectionRange?: string;
  focusLabel: string;
  focusKind: 'selection' | 'symbol' | 'file';
  focusSnippet: string;
  symbolName?: string;
  imports: string[];
  exports: string[];
  hasConditionals: boolean;
  hasValidation: boolean;
  hasAsync: boolean;
  hasErrorHandling: boolean;
  hasStateMutation: boolean;
  candidateFunctions: string[];
}

export type QuestionType =
  | 'purpose'
  | 'guarantee'
  | 'dependency'
  | 'failureMode'
  | 'designDecision'
  | 'stateChange'
  | 'edgeCase';

export interface QuizQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  target?: string;
}

export interface ReflectionItem {
  questionId: string;
  headline: string;
  body: string;
  weakArea?: string;
  tone: 'positive' | 'neutral' | 'warning';
}

export interface QuizStats {
  quizzesTaken: number;
  lastQuizAt?: string;
  streak: number;
  recentWeakAreas: string[];
}

export interface PanelState {
  kind: 'quiz' | 'empty';
  title: string;
  subtitle: string;
  contextTag?: string;
  emptyMessage?: string;
  quizContext?: QuizContext;
  questions?: QuizQuestion[];
  stats: QuizStats;
  feedback?: ReflectionItem[];
}

export interface SubmitPayload {
  answers: Record<string, string>;
}

export interface SubmitResponse {
  feedback: ReflectionItem[];
  stats: QuizStats;
}

export type ExtractionResult =
  | { ok: true; context: QuizContext }
  | { ok: false; message: string };
