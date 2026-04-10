import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeChunk, ChangeContext, ExtractionResult, QuizContext, QuizSourceMode } from './types';

interface FlatSymbol {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface DetectedChangeContext extends ChangeContext {
  startLine: number;
  endLine: number;
  previousStartLine: number;
  previousEndLine: number;
}

interface InternalChangeChunk extends ChangeChunk {
  startLine: number;
  endLine: number;
  previousStartLine: number;
  previousEndLine: number;
}

interface HunkRange {
  startLine: number;
  endLine: number;
  previousStartLine: number;
  previousEndLine: number;
  type: ChangeContext['type'];
}

interface DiffSource {
  source: ChangeContext['source'];
  label?: string;
  previousText: string;
  currentText: string;
  hunks?: HunkRange[];
}

interface DetectedChangeData {
  context: DetectedChangeContext;
  chunks: InternalChangeChunk[];
}

export interface ExtractQuizContextOptions {
  sourceMode?: QuizSourceMode;
  selectedFilePath?: string;
  workspaceFolderPath?: string;
  gitBaseRef?: string;
  gitHeadRef?: string;
  onProgress?: (update: { progress: number; stage: string; detail?: string }) => void;
}

interface ResolvedDocumentSource {
  document: vscode.TextDocument;
  selection?: vscode.Selection;
  sourceMode: QuizSourceMode;
  sourceLabel: string;
  gitRange?: {
    baseRef: string;
    headRef: string;
  };
}

const MAX_SNIPPET_LINES = 14;
const MAX_SNIPPET_LENGTH = 900;
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 1024 * 1024;
const LOOKAHEAD_LINES = 12;
const LARGE_HUNK_LINE_THRESHOLD = 72;
const WINDOW_CHUNK_SIZE = 36;
const MAX_CHUNKS = 4;
const CHUNK_SESSION_LINE_THRESHOLD = 80;
const BLOCKED_LANGUAGE_IDS = new Set([
  'plaintext',
  'log',
  'csv',
  'tsv',
  'jsonl',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.csv',
  '.jsonl',
  '.log',
  '.pdf',
  '.sqlitedb',
  '.sqlite',
  '.tsv',
  '.txt',
]);

export async function extractQuizContext(options: ExtractQuizContextOptions = {}): Promise<ExtractionResult> {
  const progress = options.onProgress ?? (() => undefined);
  progress({
    progress: 10,
    stage: 'Resolving launch source',
    detail: getSourceDetail(options.sourceMode ?? 'currentFile'),
  });

  const source = await resolveDocumentSource(options);
  if (!source.ok) {
    return source.result;
  }

  const { document, selection, gitRange, sourceLabel } = source.value;
  progress({
    progress: 22,
    stage: 'Reading source file',
    detail: sourceLabel,
  });

  const fullText = document.getText();
  if (!fullText.trim()) {
    return {
      ok: false,
      message: 'This file is empty. Open a file with code and try again.',
    };
  }

  const unsupportedReason = detectUnsupportedDocument(document, fullText);
  if (unsupportedReason) {
    return {
      ok: false,
      message: unsupportedReason,
    };
  }

  const selectionText = selection?.isEmpty
    ? undefined
    : selection
      ? document.getText(selection).trim()
      : undefined;

  progress({
    progress: 36,
    stage: gitRange ? 'Checking git commit range' : 'Inspecting local context',
    detail: gitRange ? `${gitRange.baseRef}..${gitRange.headRef}` : 'Selection, symbols, and recent changes',
  });

  const symbols = await loadSymbols(document.uri);
  const changeData = selectionText ? undefined : await detectChangeData(document, gitRange, symbols);
  progress({
    progress: 48,
    stage: 'Scoring changed areas',
    detail: selectionText
      ? 'Using your explicit selection'
      : changeData?.chunks?.length
        ? `${changeData.chunks.length} ranked chunks detected`
        : 'No change chunks detected yet',
  });
  const changeContext = changeData?.context;
  const changeChunks = changeData?.chunks ?? [];
  const isChunkedSession = shouldUseChunkedSession(changeContext, changeChunks);
  const anchorPosition = selectionText
    ? selection?.active ?? new vscode.Position(0, 0)
    : changeChunks[0]
      ? new vscode.Position(changeChunks[0].startLine, 0)
      : changeContext
        ? new vscode.Position(changeContext.startLine, 0)
        : selection?.active ?? new vscode.Position(0, 0);
  const focusSymbol = findFocusSymbol(symbols, anchorPosition);
  const focusSnippet = buildFocusSnippet(document, selection, focusSymbol, changeContext, changeChunks);
  const fileName = document.fileName
    ? path.basename(document.fileName)
    : document.uri.path.split('/').pop() ?? 'Untitled';

  const focusKind: QuizContext['focusKind'] = selectionText
    ? 'selection'
    : changeContext
      ? 'change'
      : focusSymbol
        ? 'symbol'
        : 'file';

  const symbolName = focusSymbol?.name;
  const focusLabel = selectionText
    ? symbolName
      ? `${symbolName} selection`
      : 'Selected code'
    : changeContext
      ? isChunkedSession
        ? `${changeChunks.length} ranked change chunks`
        : symbolName
          ? `${symbolName} edits`
          : 'Recent edits'
      : symbolName ?? fileName;

  const analysisText = [
    selectionText,
    changeContext?.currentSnippet,
    ...changeChunks.slice(0, 3).map((chunk) => chunk.currentSnippet),
    focusSnippet,
    fullText,
  ]
    .filter(Boolean)
    .join('\n');
  const imports = collectMatches(fullText, /^\s*import\s.+$/gm, /^\s*(?:const|let|var)\s+.+?=\s*require\(.+\)\s*;?$/gm);
  const exportsList = collectMatches(fullText, /^\s*export\s.+$/gm, /^\s*module\.exports\s*=.+$/gm);
  const candidateFunctions = collectCandidateFunctions(fullText, symbols);
  progress({
    progress: 56,
    stage: 'Preparing quiz context',
    detail: isChunkedSession
      ? 'Large change session detected'
      : 'Context is grounded and ready',
  });

  return {
    ok: true,
    context: {
      fileName,
      filePath: document.uri.fsPath || document.uri.toString(),
      languageId: document.languageId || 'code',
      lineCount: document.lineCount,
      selectionText,
      selectionRange: selectionText && selection ? formatSelection(selection) : undefined,
      focusLabel,
      focusKind,
      focusSnippet,
      symbolName,
      imports,
      exports: exportsList,
      hasConditionals: /\bif\b|\bswitch\b|\?.+:/m.test(analysisText),
      hasValidation: /validate|invalid|required|guard|assert|sanitize|schema|null|undefined|empty|length\s*[<>=]/im.test(analysisText),
      hasAsync: /\basync\b|\bawait\b|Promise\b/im.test(analysisText),
      hasErrorHandling: /\btry\b|\bcatch\b|\bthrow\b|console\.error|reject\(/im.test(analysisText),
      hasStateMutation: /set[A-Z]\w*\(|dispatch\(|push\(|splice\(|assign\(|update[A-Z]\w*\(|save[A-Z]\w*\(|create[A-Z]\w*\(|delete[A-Z]\w*\(/.test(analysisText),
      candidateFunctions,
      changeContext: changeContext ? stripInternalChangeFields(changeContext) : undefined,
      changeChunks: changeChunks.length > 0 ? changeChunks.map(stripInternalChunkFields) : undefined,
      isChunkedSession,
    },
  };
}

export async function extractQuizContextFromDocumentDiff(options: {
  document: vscode.TextDocument;
  previousText: string;
  source: ChangeContext['source'];
  label?: string;
  sessionInfo?: QuizContext['sessionInfo'];
}): Promise<QuizContext | undefined> {
  const { document, previousText, source, label, sessionInfo } = options;
  const fullText = document.getText();
  if (!fullText.trim()) {
    return undefined;
  }

  const unsupportedReason = detectUnsupportedDocument(document, fullText);
  if (unsupportedReason) {
    return undefined;
  }

  const symbols = await loadSymbols(document.uri);
  const changeData = buildChangeData(document, {
    source,
    label,
    previousText,
    currentText: fullText,
  }, symbols);

  if (!changeData) {
    return undefined;
  }

  const changeContext = changeData.context;
  const changeChunks = changeData.chunks ?? [];
  const isChunkedSession = shouldUseChunkedSession(changeContext, changeChunks);
  const anchorPosition = changeChunks[0]
    ? new vscode.Position(changeChunks[0].startLine, 0)
    : new vscode.Position(changeContext.startLine, 0);
  const focusSymbol = findFocusSymbol(symbols, anchorPosition);
  const focusSnippet = buildFocusSnippet(document, undefined, focusSymbol, changeContext, changeChunks);
  const fileName = document.fileName
    ? path.basename(document.fileName)
    : document.uri.path.split('/').pop() ?? 'Untitled';
  const analysisText = [changeContext.currentSnippet, ...changeChunks.slice(0, 3).map((chunk) => chunk.currentSnippet), focusSnippet, fullText]
    .filter(Boolean)
    .join('\n');
  const imports = collectMatches(fullText, /^\s*import\s.+$/gm, /^\s*(?:const|let|var)\s+.+?=\s*require\(.+\)\s*;?$/gm);
  const exportsList = collectMatches(fullText, /^\s*export\s.+$/gm, /^\s*module\.exports\s*=.+$/gm);
  const candidateFunctions = collectCandidateFunctions(fullText, symbols);
  const symbolName = focusSymbol?.name ?? changeChunks[0]?.symbolName;

  return {
    fileName,
    filePath: document.uri.fsPath || document.uri.toString(),
    languageId: document.languageId || 'code',
    lineCount: document.lineCount,
    focusLabel: isChunkedSession ? `${changeChunks.length} ranked change chunks` : symbolName ?? fileName,
    focusKind: 'change',
    focusSnippet,
    symbolName,
    imports,
    exports: exportsList,
    hasConditionals: /\bif\b|\bswitch\b|\?.+:/m.test(analysisText),
    hasValidation: /validate|invalid|required|guard|assert|sanitize|schema|null|undefined|empty|length\s*[<>=]/im.test(analysisText),
    hasAsync: /\basync\b|\bawait\b|Promise\b/im.test(analysisText),
    hasErrorHandling: /\btry\b|\bcatch\b|\bthrow\b|console\.error|reject\(/im.test(analysisText),
    hasStateMutation: /set[A-Z]\w*\(|dispatch\(|push\(|splice\(|assign\(|update[A-Z]\w*\(|save[A-Z]\w*\(|create[A-Z]\w*\(|delete[A-Z]\w*\(/.test(analysisText),
    candidateFunctions,
    changeContext: stripInternalChangeFields(changeContext),
    changeChunks: changeChunks.length > 0 ? changeChunks.map(stripInternalChunkFields) : undefined,
    isChunkedSession,
    sessionInfo,
  };
}

async function resolveDocumentSource(
  options: ExtractQuizContextOptions,
): Promise<{ ok: true; value: ResolvedDocumentSource } | { ok: false; result: ExtractionResult }> {
  const sourceMode = options.sourceMode ?? 'currentFile';
  const activeEditor = vscode.window.activeTextEditor;

  if (sourceMode === 'currentFile') {
    if (!activeEditor) {
      return {
        ok: false,
        result: {
          ok: false,
          message: 'Open a code file to start a VibeQuiz session.',
        },
      };
    }

    if (!['file', 'untitled'].includes(activeEditor.document.uri.scheme)) {
      return {
        ok: false,
        result: {
          ok: false,
          message: 'Open a normal text editor tab to start a VibeQuiz session.',
        },
      };
    }

    return {
      ok: true,
      value: {
        document: activeEditor.document,
        selection: activeEditor.selection,
        sourceMode,
        sourceLabel: 'Current file and active selection',
      },
    };
  }

  if (sourceMode === 'selectedFile') {
    const selectedFilePath = options.selectedFilePath?.trim();
    if (!selectedFilePath) {
      return {
        ok: false,
        result: {
          ok: false,
          message: 'Choose a source file in the VibeQuiz sidebar before launching Selected File mode.',
        },
      };
    }

    const selectedUri = vscode.Uri.file(selectedFilePath);
    try {
      await vscode.workspace.fs.stat(selectedUri);
    } catch {
      return {
        ok: false,
        result: {
          ok: false,
          message: 'The selected VibeQuiz file no longer exists. Choose another source file.',
        },
      };
    }

    const document = await vscode.workspace.openTextDocument(selectedUri);
    const selection =
      activeEditor?.document.uri.fsPath === selectedFilePath && ['file', 'untitled'].includes(activeEditor.document.uri.scheme)
        ? activeEditor.selection
        : undefined;

    return {
      ok: true,
      value: {
        document,
        selection,
        sourceMode,
        sourceLabel: `Selected file - ${path.basename(selectedFilePath)}`,
      },
    };
  }

  const workspaceFolder = resolveWorkspaceFolder(options.workspaceFolderPath, activeEditor);
  if (!workspaceFolder) {
    return {
      ok: false,
      result: {
        ok: false,
        message: 'Open a workspace folder or pick a folder in the VibeQuiz sidebar before launching a repo-level quiz.',
      },
    };
  }

  if (sourceMode === 'workspaceFolder') {
    const filePath = await resolveWorkspaceFolderSourceFile(workspaceFolder, activeEditor);
    if (!filePath) {
      return {
        ok: false,
        result: {
          ok: false,
          message: 'No changed source file was found in the selected folder. Open a source file or switch back to Current File mode.',
        },
      };
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    return {
      ok: true,
      value: {
        document,
        sourceMode,
        sourceLabel: `Workspace folder - ${workspaceFolder.name}`,
      },
    };
  }

  const baseRef = options.gitBaseRef?.trim() || 'HEAD~1';
  const headRef = options.gitHeadRef?.trim() || 'HEAD';
  const gitRangeFile = await resolveGitRangeSourceFile(workspaceFolder, baseRef, headRef, activeEditor);
  if (!gitRangeFile) {
    return {
      ok: false,
      result: {
        ok: false,
        message: `No changed source file was found for ${baseRef}..${headRef} in ${workspaceFolder.name}.`,
      },
    };
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(gitRangeFile));
  return {
    ok: true,
    value: {
      document,
      sourceMode,
      sourceLabel: `${workspaceFolder.name} - ${baseRef}..${headRef}`,
      gitRange: {
        baseRef,
        headRef,
      },
    },
  };
}

async function detectChangeData(
  document: vscode.TextDocument,
  gitRange: { baseRef: string; headRef: string } | undefined,
  symbols: FlatSymbol[],
): Promise<DetectedChangeData | undefined> {
  let diffSource: DiffSource | undefined;

  if (gitRange) {
    diffSource = await loadGitRangeChangeSource(document, gitRange.baseRef, gitRange.headRef);
  } else {
    diffSource = await loadDirtyBufferChangeSource(document);
    diffSource = diffSource ?? await loadGitHeadChangeSource(document);
    diffSource = diffSource ?? await loadLastCommitChangeSource(document);
  }

  if (!diffSource) {
    return undefined;
  }

  return buildChangeData(document, diffSource, symbols);
}

async function loadDirtyBufferChangeSource(document: vscode.TextDocument): Promise<DiffSource | undefined> {
  if (!document.isDirty || document.uri.scheme !== 'file') {
    return undefined;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const diskText = new TextDecoder('utf-8').decode(bytes);
    return {
      source: 'dirty-buffer',
      previousText: diskText,
      currentText: document.getText(),
      hunks: buildHeuristicHunks(diskText, document.getText()),
    };
  } catch {
    return undefined;
  }
}

async function loadGitHeadChangeSource(document: vscode.TextDocument): Promise<DiffSource | undefined> {
  const gitFile = await resolveGitFile(document);
  if (!gitFile) {
    return undefined;
  }

  const headText = await execGit(['-C', gitFile.repoRoot, 'show', `HEAD:${gitFile.relativePath}`]).catch(() => undefined);
  if (typeof headText === 'string') {
    const diffText = await execGit([
      '-C',
      gitFile.repoRoot,
      'diff',
      '--unified=0',
      'HEAD',
      '--',
      gitFile.relativePath,
    ]).catch(() => '');

    return {
      source: 'git-head',
      previousText: headText,
      currentText: document.getText(),
      hunks: parseGitDiffHunks(diffText, document.lineCount),
    };
  }

  const untracked = await execGit(['-C', gitFile.repoRoot, 'ls-files', '--others', '--exclude-standard', '--', gitFile.relativePath]).catch(() => '');
  if (!untracked.trim()) {
    return undefined;
  }

  return {
    source: 'git-head',
    previousText: '',
    currentText: document.getText(),
    hunks: buildHeuristicHunks('', document.getText()),
  };
}

async function loadLastCommitChangeSource(document: vscode.TextDocument): Promise<DiffSource | undefined> {
  const gitFile = await resolveGitFile(document);
  if (!gitFile) {
    return undefined;
  }

  const hasPreviousCommit = await execGit(['-C', gitFile.repoRoot, 'rev-parse', '--verify', 'HEAD~1']).catch(() => undefined);
  if (!hasPreviousCommit) {
    return undefined;
  }

  const changedInLatestCommit = await execGit([
    '-C',
    gitFile.repoRoot,
    'diff',
    '--name-only',
    'HEAD~1',
    'HEAD',
    '--',
    gitFile.relativePath,
  ]).catch(() => '');

  if (!changedInLatestCommit.trim()) {
    return undefined;
  }

  const currentHeadText = await execGit(['-C', gitFile.repoRoot, 'show', `HEAD:${gitFile.relativePath}`]).catch(() => document.getText());
  const previousText = await execGit(['-C', gitFile.repoRoot, 'show', `HEAD~1:${gitFile.relativePath}`]).catch(() => '');
  const diffText = await execGit([
    '-C',
    gitFile.repoRoot,
    'diff',
    '--unified=0',
    'HEAD~1',
    'HEAD',
    '--',
    gitFile.relativePath,
  ]).catch(() => '');

  return {
    source: 'last-commit',
    previousText,
    currentText: currentHeadText,
    hunks: parseGitDiffHunks(diffText, splitLines(currentHeadText).length),
  };
}

async function loadGitRangeChangeSource(
  document: vscode.TextDocument,
  baseRef: string,
  headRef: string,
): Promise<DiffSource | undefined> {
  const gitFile = await resolveGitFile(document);
  if (!gitFile) {
    return undefined;
  }

  const changedInRange = await execGit([
    '-C',
    gitFile.repoRoot,
    'diff',
    '--name-only',
    baseRef,
    headRef,
    '--',
    gitFile.relativePath,
  ]).catch(() => '');

  if (!changedInRange.trim()) {
    return undefined;
  }

  const currentText = await execGit(['-C', gitFile.repoRoot, 'show', `${headRef}:${gitFile.relativePath}`]).catch(() => document.getText());
  const previousText = await execGit(['-C', gitFile.repoRoot, 'show', `${baseRef}:${gitFile.relativePath}`]).catch(() => '');
  const diffText = await execGit([
    '-C',
    gitFile.repoRoot,
    'diff',
    '--unified=0',
    baseRef,
    headRef,
    '--',
    gitFile.relativePath,
  ]).catch(() => '');

  return {
    source: 'git-range',
    label: `${baseRef}..${headRef}`,
    previousText,
    currentText,
    hunks: parseGitDiffHunks(diffText, splitLines(currentText).length),
  };
}

function buildChangeData(
  document: vscode.TextDocument,
  diffSource: DiffSource,
  symbols: FlatSymbol[],
): DetectedChangeData | undefined {
  const changeContext = buildChangeContext(diffSource.source, diffSource.previousText, diffSource.currentText);
  if (!changeContext) {
    return undefined;
  }

  if (diffSource.label) {
    changeContext.label = diffSource.label;
  }

  const baseHunks = normalizeHunks(
    diffSource.hunks && diffSource.hunks.length > 0
      ? diffSource.hunks
      : buildHeuristicHunks(diffSource.previousText, diffSource.currentText),
    changeContext,
  );
  const expandedHunks = expandLargeHunks(baseHunks, symbols);
  const rankedChunks = buildRankedChunks(document, diffSource.previousText, diffSource.currentText, expandedHunks, symbols);

  return {
    context: changeContext,
    chunks: rankedChunks,
  };
}

function buildChangeContext(
  source: ChangeContext['source'],
  previousText: string,
  currentText: string,
): DetectedChangeContext | undefined {
  const previousLines = splitLines(previousText);
  const currentLines = splitLines(currentText);

  let prefix = 0;
  const maxPrefix = Math.min(previousLines.length, currentLines.length);
  while (prefix < maxPrefix && previousLines[prefix] === currentLines[prefix]) {
    prefix += 1;
  }

  let previousEnd = previousLines.length - 1;
  let currentEnd = currentLines.length - 1;
  while (previousEnd >= prefix && currentEnd >= prefix && previousLines[previousEnd] === currentLines[currentEnd]) {
    previousEnd -= 1;
    currentEnd -= 1;
  }

  if (prefix > previousEnd && prefix > currentEnd) {
    return undefined;
  }

  const currentChangedLines = currentEnd >= prefix ? currentLines.slice(prefix, currentEnd + 1) : [];
  const previousChangedLines = previousEnd >= prefix ? previousLines.slice(prefix, previousEnd + 1) : [];
  const type: ChangeContext['type'] = currentChangedLines.length === 0
    ? 'removed'
    : previousChangedLines.length === 0
      ? 'added'
      : 'modified';

  const startLine = currentChangedLines.length > 0
    ? prefix
    : Math.max(0, Math.min(prefix, Math.max(currentLines.length - 1, 0)));
  const endLine = currentChangedLines.length > 0
    ? currentEnd
    : startLine;
  const currentSnippet = currentChangedLines.length > 0
    ? sanitizeSnippet(currentChangedLines.join('\n'))
    : sanitizeSnippet(getSurroundingLines(currentLines, startLine, 6).join('\n'));
  const previousSnippet = previousChangedLines.length > 0
    ? sanitizeSnippet(previousChangedLines.join('\n'))
    : undefined;

  return {
    source,
    type,
    label:
      source === 'dirty-buffer'
        ? 'Unsaved edits vs saved file'
        : source === 'git-range'
          ? 'Selected git range'
          : source === 'last-commit'
            ? 'Latest commit vs previous commit'
            : 'Changes vs git HEAD',
    range: formatLineRange(startLine + 1, endLine + 1),
    lineCount: Math.max(currentChangedLines.length, previousChangedLines.length, 1),
    currentSnippet,
    previousSnippet,
    startLine,
    endLine,
    previousStartLine: previousChangedLines.length > 0 ? prefix : Math.max(prefix - 1, 0),
    previousEndLine: previousChangedLines.length > 0 ? previousEnd : Math.max(prefix - 1, 0),
  };
}

function normalizeHunks(hunks: HunkRange[], fallback: DetectedChangeContext): HunkRange[] {
  const normalized = hunks
    .map((hunk) => ({
      startLine: Math.max(0, hunk.startLine),
      endLine: Math.max(Math.max(0, hunk.startLine), hunk.endLine),
      previousStartLine: Math.max(-1, hunk.previousStartLine),
      previousEndLine: Math.max(hunk.previousStartLine, hunk.previousEndLine),
      type: hunk.type,
    }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  if (normalized.length === 0) {
    return [{
      startLine: fallback.startLine,
      endLine: fallback.endLine,
      previousStartLine: fallback.previousStartLine,
      previousEndLine: fallback.previousEndLine,
      type: fallback.type,
    }];
  }

  const merged: HunkRange[] = [];
  for (const hunk of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || hunk.startLine > previous.endLine + 1) {
      merged.push({ ...hunk });
      continue;
    }

    previous.endLine = Math.max(previous.endLine, hunk.endLine);
    previous.previousEndLine = Math.max(previous.previousEndLine, hunk.previousEndLine);
    previous.type = previous.type === hunk.type ? previous.type : 'modified';
  }

  return merged;
}

function expandLargeHunks(hunks: HunkRange[], symbols: FlatSymbol[]): HunkRange[] {
  const expanded: HunkRange[] = [];

  for (const hunk of hunks) {
    const lineCount = hunk.endLine - hunk.startLine + 1;
    if (lineCount < LARGE_HUNK_LINE_THRESHOLD || hunk.type === 'removed') {
      expanded.push(hunk);
      continue;
    }

    const symbolSplits = createSymbolSplits(hunk, symbols);
    if (symbolSplits.length >= 2) {
      expanded.push(...symbolSplits);
      continue;
    }

    expanded.push(...createWindowSplits(hunk, WINDOW_CHUNK_SIZE));
  }

  return expanded;
}

function createSymbolSplits(hunk: HunkRange, symbols: FlatSymbol[]): HunkRange[] {
  const overlapping = symbols
    .filter((symbol) => isChunkableSymbol(symbol.kind) && symbol.range.end.line >= hunk.startLine && symbol.range.start.line <= hunk.endLine)
    .sort((left, right) => left.range.start.line - right.range.start.line);

  if (overlapping.length < 2) {
    return [];
  }

  return overlapping.map((symbol) => ({
    startLine: Math.max(hunk.startLine, symbol.range.start.line),
    endLine: Math.min(hunk.endLine, symbol.range.end.line),
    previousStartLine: -1,
    previousEndLine: -1,
    type: hunk.type,
  })).filter((chunk) => chunk.endLine >= chunk.startLine);
}

function createWindowSplits(hunk: HunkRange, windowSize: number): HunkRange[] {
  const chunks: HunkRange[] = [];
  for (let startLine = hunk.startLine; startLine <= hunk.endLine; startLine += windowSize) {
    const endLine = Math.min(hunk.endLine, startLine + windowSize - 1);
    chunks.push({
      startLine,
      endLine,
      previousStartLine: -1,
      previousEndLine: -1,
      type: hunk.type,
    });
  }

  return chunks;
}

function buildRankedChunks(
  document: vscode.TextDocument,
  previousText: string,
  currentText: string,
  hunks: HunkRange[],
  symbols: FlatSymbol[],
): InternalChangeChunk[] {
  const currentLines = splitLines(currentText);
  const previousLines = splitLines(previousText);
  const ranked = hunks.map((hunk, index) => {
    const symbol = findNearestChunkSymbol(symbols, hunk.startLine, hunk.endLine);
    const currentSnippet = buildChunkSnippet(currentLines, hunk.startLine, hunk.endLine, hunk.type);
    const previousSnippet = buildPreviousChunkSnippet(previousLines, hunk.previousStartLine, hunk.previousEndLine);
    const scored = scoreChunk(currentSnippet, hunk, symbol);
    const label = symbol?.name ?? `Chunk ${index + 1}`;

    return {
      id: `chunk-${index + 1}`,
      label,
      symbolName: symbol?.name,
      fileName: path.basename(document.fileName || document.uri.fsPath || document.uri.path || 'Untitled'),
      filePath: document.uri.fsPath || document.uri.toString(),
      languageId: document.languageId || 'code',
      type: hunk.type,
      range: formatLineRange(hunk.startLine + 1, hunk.endLine + 1),
      lineCount: hunk.type === 'removed'
        ? Math.max(hunk.previousEndLine - hunk.previousStartLine + 1, 1)
        : Math.max(hunk.endLine - hunk.startLine + 1, 1),
      score: scored.score,
      reasons: scored.reasons,
      currentSnippet,
      previousSnippet,
      startLine: clampLine(document.lineCount, hunk.startLine),
      endLine: clampLine(document.lineCount, hunk.endLine),
      previousStartLine: hunk.previousStartLine,
      previousEndLine: hunk.previousEndLine,
    } satisfies InternalChangeChunk;
  });

  return ranked
    .sort((left, right) => right.score - left.score || left.startLine - right.startLine)
    .slice(0, MAX_CHUNKS);
}

function buildChunkSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
  type: ChangeContext['type'],
): string {
  if (type === 'removed') {
    const anchor = Math.max(0, Math.min(startLine, Math.max(lines.length - 1, 0)));
    return sanitizeSnippet(getSurroundingLines(lines, anchor, 4).join('\n'));
  }

  return sanitizeSnippet(lines.slice(startLine, endLine + 1).join('\n'));
}

function buildPreviousChunkSnippet(
  previousLines: string[],
  previousStartLine: number,
  previousEndLine: number,
): string | undefined {
  if (previousStartLine < 0 || previousEndLine < previousStartLine || previousLines.length === 0) {
    return undefined;
  }

  return sanitizeSnippet(previousLines.slice(previousStartLine, previousEndLine + 1).join('\n'));
}

function scoreChunk(
  snippet: string,
  hunk: HunkRange,
  symbol: FlatSymbol | undefined,
): { score: number; reasons: string[] } {
  let score = Math.min(10, Math.ceil((hunk.endLine - hunk.startLine + 1) / 6));
  const reasons: string[] = [];

  const addReason = (label: string, weight: number, pattern?: RegExp): void => {
    if (pattern && !pattern.test(snippet)) {
      return;
    }

    score += weight;
    if (!reasons.includes(label)) {
      reasons.push(label);
    }
  };

  addReason('validation', 4, /validate|invalid|required|guard|assert|sanitize|schema|null|undefined|empty/im);
  addReason('conditionals', 3, /\bif\b|\bswitch\b|\?.+:/m);
  addReason('error-handling', 4, /\btry\b|\bcatch\b|\bthrow\b|reject\(|console\.error/im);
  addReason('async', 3, /\basync\b|\bawait\b|Promise\b/im);
  addReason('state', 3, /set[A-Z]\w*\(|dispatch\(|push\(|splice\(|assign\(|update[A-Z]\w*\(|save[A-Z]\w*\(|create[A-Z]\w*\(|delete[A-Z]\w*\(/);

  if (symbol) {
    score += isHighValueSymbol(symbol.kind) ? 4 : 2;
    reasons.push('symbol-boundary');
  }

  if (hunk.type === 'modified') {
    score += 2;
  }

  if (hunk.type === 'removed') {
    reasons.push('removed-contract');
  }

  return {
    score,
    reasons: reasons.slice(0, 3),
  };
}

function shouldUseChunkedSession(
  changeContext: DetectedChangeContext | undefined,
  changeChunks: InternalChangeChunk[],
): boolean {
  if (!changeContext || changeChunks.length < 2) {
    return false;
  }

  return (
    changeContext.lineCount >= CHUNK_SESSION_LINE_THRESHOLD ||
    changeChunks.length >= 3 ||
    (changeChunks.length >= 2 && changeContext.lineCount >= 40)
  );
}

function buildHeuristicHunks(previousText: string, currentText: string): HunkRange[] {
  const previousLines = splitLines(previousText);
  const currentLines = splitLines(currentText);
  const hunks: HunkRange[] = [];
  let previousIndex = 0;
  let currentIndex = 0;

  while (previousIndex < previousLines.length || currentIndex < currentLines.length) {
    if (
      previousIndex < previousLines.length &&
      currentIndex < currentLines.length &&
      previousLines[previousIndex] === currentLines[currentIndex]
    ) {
      previousIndex += 1;
      currentIndex += 1;
      continue;
    }

    const startPrevious = previousIndex;
    const startCurrent = currentIndex;
    const nextMatch = findNextAlignedMatch(previousLines, currentLines, previousIndex, currentIndex);

    if (nextMatch) {
      previousIndex = nextMatch.previousIndex;
      currentIndex = nextMatch.currentIndex;
    } else {
      previousIndex = previousLines.length;
      currentIndex = currentLines.length;
    }

    const previousEnd = Math.max(startPrevious, previousIndex) - 1;
    const currentEnd = Math.max(startCurrent, currentIndex) - 1;

    if (previousEnd < startPrevious && currentEnd < startCurrent) {
      continue;
    }

    hunks.push({
      startLine: currentEnd >= startCurrent
        ? startCurrent
        : Math.max(0, Math.min(startCurrent, Math.max(currentLines.length - 1, 0))),
      endLine: currentEnd >= startCurrent
        ? currentEnd
        : Math.max(0, Math.min(startCurrent, Math.max(currentLines.length - 1, 0))),
      previousStartLine: previousEnd >= startPrevious ? startPrevious : Math.max(startPrevious - 1, 0),
      previousEndLine: previousEnd >= startPrevious ? previousEnd : Math.max(startPrevious - 1, 0),
      type: currentEnd < startCurrent
        ? 'removed'
        : previousEnd < startPrevious
          ? 'added'
          : 'modified',
    });
  }

  return hunks;
}

function findNextAlignedMatch(
  previousLines: string[],
  currentLines: string[],
  previousIndex: number,
  currentIndex: number,
): { previousIndex: number; currentIndex: number } | undefined {
  for (let delta = 1; delta <= LOOKAHEAD_LINES; delta += 1) {
    for (let added = 0; added <= delta; added += 1) {
      const removed = delta - added;
      const nextPrevious = previousIndex + removed;
      const nextCurrent = currentIndex + added;

      if (
        nextPrevious < previousLines.length &&
        nextCurrent < currentLines.length &&
        previousLines[nextPrevious] === currentLines[nextCurrent]
      ) {
        return {
          previousIndex: nextPrevious,
          currentIndex: nextCurrent,
        };
      }
    }
  }

  return undefined;
}

function parseGitDiffHunks(diffText: string, currentLineCount: number): HunkRange[] {
  const hunks: HunkRange[] = [];

  for (const line of diffText.split(/\r?\n/)) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      continue;
    }

    const previousStart = Math.max(1, Number(match[1] ?? '1'));
    const previousCount = Number(match[2] ?? '1');
    const currentStart = Math.max(1, Number(match[3] ?? '1'));
    const currentCount = Number(match[4] ?? '1');
    const type: ChangeContext['type'] = currentCount === 0
      ? 'removed'
      : previousCount === 0
        ? 'added'
        : 'modified';
    const startLine = currentCount > 0
      ? currentStart - 1
      : clampLine(currentLineCount, currentStart - 1);
    const endLine = currentCount > 0
      ? Math.max(startLine, currentStart + currentCount - 2)
      : startLine;

    hunks.push({
      startLine,
      endLine,
      previousStartLine: previousStart - 1,
      previousEndLine: previousCount > 0 ? previousStart + previousCount - 2 : previousStart - 1,
      type,
    });
  }

  return hunks;
}

async function loadSymbols(uri: vscode.Uri): Promise<FlatSymbol[]> {
  try {
    const provided = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );

    if (!provided || provided.length === 0) {
      return [];
    }

    const flattened: FlatSymbol[] = [];

    const walkDocumentSymbols = (symbols: vscode.DocumentSymbol[]): void => {
      for (const symbol of symbols) {
        flattened.push({
          name: symbol.name,
          kind: symbol.kind,
          range: symbol.range,
          selectionRange: symbol.selectionRange,
        });

        if (symbol.children.length > 0) {
          walkDocumentSymbols(symbol.children);
        }
      }
    };

    if ('location' in provided[0]) {
      for (const symbol of provided as vscode.SymbolInformation[]) {
        flattened.push({
          name: symbol.name,
          kind: symbol.kind,
          range: symbol.location.range,
          selectionRange: symbol.location.range,
        });
      }
    } else {
      walkDocumentSymbols(provided as vscode.DocumentSymbol[]);
    }

    return flattened;
  } catch {
    return [];
  }
}

function findFocusSymbol(symbols: FlatSymbol[], position: vscode.Position): FlatSymbol | undefined {
  return symbols
    .filter((symbol) => symbol.range.contains(position))
    .sort((left, right) => left.range.end.line - left.range.start.line - (right.range.end.line - right.range.start.line))[0];
}

function findNearestChunkSymbol(symbols: FlatSymbol[], startLine: number, endLine: number): FlatSymbol | undefined {
  return symbols
    .filter((symbol) => isChunkableSymbol(symbol.kind))
    .map((symbol) => ({
      symbol,
      distance: symbol.range.end.line < startLine
        ? startLine - symbol.range.end.line
        : symbol.range.start.line > endLine
          ? symbol.range.start.line - endLine
          : 0,
      span: symbol.range.end.line - symbol.range.start.line,
    }))
    .sort((left, right) => left.distance - right.distance || left.span - right.span)[0]?.symbol;
}

function buildFocusSnippet(
  document: vscode.TextDocument,
  selection: vscode.Selection | undefined,
  focusSymbol: FlatSymbol | undefined,
  changeContext: DetectedChangeContext | undefined,
  changeChunks: InternalChangeChunk[],
): string {
  if (selection && !selection.isEmpty) {
    return sanitizeSnippet(document.getText(selection));
  }

  if (changeChunks.length > 0) {
    return changeChunks[0].currentSnippet;
  }

  if (changeContext) {
    return changeContext.currentSnippet;
  }

  if (focusSymbol) {
    return sanitizeSnippet(document.getText(focusSymbol.range));
  }

  const endLine = Math.min(document.lineCount - 1, 23);
  const fallbackRange = new vscode.Range(
    new vscode.Position(0, 0),
    document.lineAt(endLine).range.end,
  );

  return sanitizeSnippet(document.getText(fallbackRange));
}

function sanitizeSnippet(snippet: string): string {
  const lines = snippet
    .replace(/\t/g, '  ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line, index, source) => !(index === 0 && line === '') && !(index === source.length - 1 && line === ''));

  const trimmedLines = lines.slice(0, MAX_SNIPPET_LINES);
  const joined = trimmedLines.join('\n');
  const capped = joined.length > MAX_SNIPPET_LENGTH ? `${joined.slice(0, MAX_SNIPPET_LENGTH)}\n...` : joined;

  return capped || '// No preview available';
}

function stripInternalChangeFields(changeContext: DetectedChangeContext): ChangeContext {
  return {
    source: changeContext.source,
    type: changeContext.type,
    label: changeContext.label,
    range: changeContext.range,
    lineCount: changeContext.lineCount,
    currentSnippet: changeContext.currentSnippet,
    previousSnippet: changeContext.previousSnippet,
  };
}

function stripInternalChunkFields(chunk: InternalChangeChunk): ChangeChunk {
  return {
    id: chunk.id,
    label: chunk.label,
    symbolName: chunk.symbolName,
    fileName: chunk.fileName,
    filePath: chunk.filePath,
    languageId: chunk.languageId,
    type: chunk.type,
    range: chunk.range,
    lineCount: chunk.lineCount,
    score: chunk.score,
    reasons: chunk.reasons,
    currentSnippet: chunk.currentSnippet,
    previousSnippet: chunk.previousSnippet,
  };
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }

  return value.replace(/\r\n/g, '\n').split('\n');
}

function detectUnsupportedDocument(document: vscode.TextDocument, fullText: string): string | undefined {
  const extension = path.extname(document.fileName || '').toLowerCase();
  if (BLOCKED_LANGUAGE_IDS.has(document.languageId) || BLOCKED_EXTENSIONS.has(extension)) {
    return 'VibeQuiz works best on source files. This tab looks like data rather than code, so the quiz is skipped.';
  }

  const trimmed = fullText.trim();
  if (!trimmed) {
    return undefined;
  }

  const lines = splitLines(trimmed).slice(0, 24);
  const jsonRecordLines = lines.filter((line) => {
    const compact = line.trim();
    return compact.startsWith('{') && compact.endsWith('}');
  });

  if (lines.length >= 3 && jsonRecordLines.length >= Math.min(3, lines.length)) {
    return 'VibeQuiz skipped this file because it looks like record data, not code. Open a source file to get sharper questions.';
  }

  return undefined;
}

function getSurroundingLines(lines: string[], lineIndex: number, radius: number): string[] {
  if (lines.length === 0) {
    return ['// Change removed code here'];
  }

  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length, lineIndex + radius + 1);
  return lines.slice(start, end);
}

function formatSelection(selection: vscode.Selection): string {
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function formatLineRange(start: number, end: number): string {
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function collectMatches(text: string, ...patterns: RegExp[]): string[] {
  const values = new Set<string>();

  for (const pattern of patterns) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      values.add(match.trim());
    }
  }

  return Array.from(values).slice(0, 6);
}

function collectCandidateFunctions(text: string, symbols: FlatSymbol[]): string[] {
  const values = new Set<string>();

  for (const symbol of symbols) {
    if (
      symbol.kind === vscode.SymbolKind.Function ||
      symbol.kind === vscode.SymbolKind.Method ||
      symbol.kind === vscode.SymbolKind.Constructor
    ) {
      values.add(symbol.name);
    }
  }

  const patterns = [
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function\s*\(/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        values.add(match[1]);
      }
    }
  }

  return Array.from(values).slice(0, 6);
}

function resolveWorkspaceFolder(
  configuredPath: string | undefined,
  activeEditor: vscode.TextEditor | undefined,
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }

  if (configuredPath) {
    const exact = folders.find((folder) => folder.uri.fsPath === configuredPath);
    if (exact) {
      return exact;
    }
  }

  const editorFolder = activeEditor ? vscode.workspace.getWorkspaceFolder(activeEditor.document.uri) : undefined;
  if (editorFolder) {
    return editorFolder;
  }

  return folders[0];
}

async function resolveWorkspaceFolderSourceFile(
  workspaceFolder: vscode.WorkspaceFolder,
  _activeEditor: vscode.TextEditor | undefined,
): Promise<string | undefined> {
  const changedFiles = await collectWorkingTreeFiles(workspaceFolder);
  return changedFiles.find((filePath) => isSupportedSourceFile(filePath));
}

async function resolveGitRangeSourceFile(
  workspaceFolder: vscode.WorkspaceFolder,
  baseRef: string,
  headRef: string,
  _activeEditor: vscode.TextEditor | undefined,
): Promise<string | undefined> {
  const changedFiles = await collectGitRangeFiles(workspaceFolder, baseRef, headRef);
  if (changedFiles.length === 0) {
    return undefined;
  }

  return changedFiles.find((filePath) => isSupportedSourceFile(filePath));
}

async function collectWorkingTreeFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
  const repoRoot = workspaceFolder.uri.fsPath;
  const relativeFolder = '.';
  const numstat = await execGit(['-C', repoRoot, 'diff', '--numstat', 'HEAD', '--', '.']).catch(() => '');
  const untracked = await execGit(['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '--', relativeFolder]).catch(() => '');
  return rankChangedFiles(repoRoot, parseGitNumstat(numstat), splitGitPaths(untracked));
}

async function collectGitRangeFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  const repoRoot = workspaceFolder.uri.fsPath;
  const numstat = await execGit(['-C', repoRoot, 'diff', '--numstat', baseRef, headRef, '--', '.']).catch(() => '');
  return rankChangedFiles(repoRoot, parseGitNumstat(numstat), []);
}

function splitGitPaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseGitNumstat(value: string): Array<{ relativePath: string; score: number }> {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) {
        return undefined;
      }

      const additions = Number(parts[0] === '-' ? 0 : parts[0]);
      const deletions = Number(parts[1] === '-' ? 0 : parts[1]);
      const relativePath = parts.slice(2).join('\t').trim();
      if (!relativePath) {
        return undefined;
      }

      return {
        relativePath,
        score: Math.max(1, additions + deletions),
      };
    })
    .filter((item): item is { relativePath: string; score: number } => Boolean(item));
}

function rankChangedFiles(
  repoRoot: string,
  rankedChanges: Array<{ relativePath: string; score: number }>,
  untrackedRelativePaths: string[],
): string[] {
  const scoreByPath = new Map<string, number>();

  for (const change of rankedChanges) {
    scoreByPath.set(change.relativePath, Math.max(scoreByPath.get(change.relativePath) ?? 0, change.score));
  }

  for (const relativePath of untrackedRelativePaths) {
    scoreByPath.set(relativePath, Math.max(scoreByPath.get(relativePath) ?? 0, 80));
  }

  return Array.from(scoreByPath.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([relativePath]) => path.join(repoRoot, relativePath.replace(/\//g, path.sep)));
}

function isPathInsideFolder(filePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSupportedSourceFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return !BLOCKED_EXTENSIONS.has(extension);
}

function getSourceDetail(sourceMode: QuizSourceMode): string {
  switch (sourceMode) {
    case 'selectedFile':
      return 'Using the file you pinned in the sidebar, with selection if that file is currently open';
    case 'workspaceFolder':
      return 'Looking for the best changed source file in the selected folder';
    case 'gitRange':
      return 'Comparing the selected commit refs and finding a changed source file';
    case 'currentFile':
    default:
      return 'Starting with the active file, then falling back to recent workspace or commit changes if needed';
  }
}

async function resolveGitFile(
  document: vscode.TextDocument,
): Promise<{ repoRoot: string; relativePath: string } | undefined> {
  if (document.uri.scheme !== 'file' || !document.uri.fsPath) {
    return undefined;
  }

  const root = await execGit(['-C', path.dirname(document.uri.fsPath), 'rev-parse', '--show-toplevel']).catch(() => undefined);
  if (!root) {
    return undefined;
  }

  const repoRoot = root.trim();
  const relativePath = toGitRelativePath(repoRoot, document.uri.fsPath);
  if (!relativePath) {
    return undefined;
  }

  return { repoRoot, relativePath };
}

function toGitRelativePath(repoRoot: string, filePath: string): string | undefined {
  const relativePath = path.relative(repoRoot, filePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return undefined;
  }

  return relativePath.replace(/\\/g, '/');
}

function isChunkableSymbol(kind: vscode.SymbolKind): boolean {
  return [
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Namespace,
    vscode.SymbolKind.Module,
  ].includes(kind);
}

function isHighValueSymbol(kind: vscode.SymbolKind): boolean {
  return [
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Class,
  ].includes(kind);
}

function clampLine(lineCount: number, line: number): number {
  if (lineCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(line, lineCount - 1));
}

function execGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}
