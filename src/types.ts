export interface QuizContext {
  fileName: string;
  filePath: string;
  languageId: string;
  lineCount: number;
  selectionText?: string;
  selectionRange?: string;
  focusLabel: string;
  focusKind: 'selection' | 'change' | 'symbol' | 'file';
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
  changeContext?: ChangeContext;
  changeChunks?: ChangeChunk[];
  isChunkedSession?: boolean;
  sessionInfo?: SessionInfo;
}

export interface ChangeContext {
  source: 'dirty-buffer' | 'git-head' | 'last-commit' | 'git-range' | 'session';
  type: 'added' | 'modified' | 'removed';
  label: string;
  range: string;
  lineCount: number;
  currentSnippet: string;
  previousSnippet?: string;
}

export interface ChangeChunk {
  id: string;
  label: string;
  symbolName?: string;
  fileName?: string;
  filePath?: string;
  languageId?: string;
  type: ChangeContext['type'];
  range: string;
  lineCount: number;
  score: number;
  reasons: string[];
  currentSnippet: string;
  previousSnippet?: string;
}

export type QuizMode = 'heuristic' | 'ai';
export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'openaiCompatible';
export type QuizSourceMode = 'currentFile' | 'selectedFile' | 'workspaceFolder' | 'gitRange';

export type QuestionType =
  | 'purpose'
  | 'guarantee'
  | 'dependency'
  | 'failureMode'
  | 'designDecision'
  | 'stateChange'
  | 'edgeCase';

export type QuizOptionId = 'a' | 'b' | 'c' | 'd';

export interface QuizOption {
  id: QuizOptionId;
  text: string;
}

export interface QuizQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  target?: string;
  chunkId?: string;
  chunkLabel?: string;
  options: QuizOption[];
  correctOptionId: QuizOptionId;
  explanation: string;
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
  recentChunkWeakAreas: ChunkWeakArea[];
}

export interface QuizResultSummary {
  correct: number;
  total: number;
  skipped: number;
}

export interface ChunkWeakArea {
  chunkId: string;
  label: string;
  weakAreas: string[];
}

export interface SessionInfo {
  id: string;
  startedAt: string;
  endedAt?: string;
  workspaceName: string;
  workspacePath: string;
  baseRefLabel: string;
  touchedFileCount: number;
  changedFileCount: number;
}

export interface ModeStatus {
  mode: QuizMode;
  label: string;
  detail: string;
  provider?: AiProvider;
  model?: string;
  keyConfigured: boolean;
}

export interface PanelState {
  kind: 'quiz' | 'empty' | 'loading';
  title: string;
  subtitle: string;
  contextTag?: string;
  modeStatus: ModeStatus;
  emptyMessage?: string;
  loadingProgress?: number;
  loadingStage?: string;
  loadingDetail?: string;
  loadingDetails?: string[];
  quizContext?: QuizContext;
  questions?: QuizQuestion[];
  stats: QuizStats;
  feedback?: ReflectionItem[];
  resultSummary?: QuizResultSummary;
  chunkWeakAreas?: ChunkWeakArea[];
}

export interface SubmitPayload {
  answers: Record<string, string>;
}

export interface SubmitResponse {
  feedback: ReflectionItem[];
  stats: QuizStats;
  summary: QuizResultSummary;
  chunkWeakAreas?: ChunkWeakArea[];
}

export type ExtractionResult =
  | { ok: true; context: QuizContext }
  | { ok: false; message: string };
