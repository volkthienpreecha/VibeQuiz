import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeContext, ExtractionResult, QuizContext } from './types';

interface FlatSymbol {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface DetectedChangeContext extends ChangeContext {
  startLine: number;
  endLine: number;
}

const MAX_SNIPPET_LINES = 14;
const MAX_SNIPPET_LENGTH = 900;
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 1024 * 1024;
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

export async function extractQuizContext(): Promise<ExtractionResult> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return {
      ok: false,
      message: 'Open a code file to start a VibeQuiz session.',
    };
  }

  const document = editor.document;

  if (!['file', 'untitled'].includes(document.uri.scheme)) {
    return {
      ok: false,
      message: 'Open a normal text editor tab to start a VibeQuiz session.',
    };
  }

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

  const selectionText = editor.selection.isEmpty
    ? undefined
    : document.getText(editor.selection).trim();

  const symbols = await loadSymbols(document.uri);
  const changeContext = selectionText ? undefined : await detectChangeContext(document);
  const anchorPosition = selectionText
    ? editor.selection.active
    : changeContext
      ? new vscode.Position(changeContext.startLine, 0)
      : editor.selection.active;
  const focusSymbol = findFocusSymbol(symbols, anchorPosition);
  const focusSnippet = buildFocusSnippet(document, editor.selection, focusSymbol, changeContext);
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
      ? symbolName
        ? `${symbolName} edits`
        : 'Recent edits'
      : symbolName ?? fileName;

  const analysisText = [selectionText, changeContext?.currentSnippet, focusSnippet, fullText].filter(Boolean).join('\n');
  const imports = collectMatches(fullText, /^\s*import\s.+$/gm, /^\s*(?:const|let|var)\s+.+?=\s*require\(.+\)\s*;?$/gm);
  const exportsList = collectMatches(fullText, /^\s*export\s.+$/gm, /^\s*module\.exports\s*=.+$/gm);
  const candidateFunctions = collectCandidateFunctions(fullText, symbols);

  return {
    ok: true,
    context: {
      fileName,
      filePath: document.uri.fsPath || document.uri.toString(),
      languageId: document.languageId || 'code',
      lineCount: document.lineCount,
      selectionText,
      selectionRange: selectionText ? formatSelection(editor.selection) : undefined,
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
    },
  };
}

async function detectChangeContext(document: vscode.TextDocument): Promise<DetectedChangeContext | undefined> {
  const dirtyBufferChange = await loadDirtyBufferChange(document);
  if (dirtyBufferChange) {
    return dirtyBufferChange;
  }

  const gitHeadChange = await loadGitHeadChange(document);
  if (gitHeadChange) {
    return gitHeadChange;
  }

  return loadLastCommitChange(document);
}

async function loadDirtyBufferChange(document: vscode.TextDocument): Promise<DetectedChangeContext | undefined> {
  if (!document.isDirty || document.uri.scheme !== 'file') {
    return undefined;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const diskText = new TextDecoder('utf-8').decode(bytes);
    return buildChangeContext('dirty-buffer', diskText, document.getText());
  } catch {
    return undefined;
  }
}

async function loadGitHeadChange(document: vscode.TextDocument): Promise<DetectedChangeContext | undefined> {
  const gitFile = await resolveGitFile(document);
  if (!gitFile) {
    return undefined;
  }

  const headText = await execGit(['-C', gitFile.repoRoot, 'show', `HEAD:${gitFile.relativePath}`]).catch(() => undefined);
  if (typeof headText === 'string') {
    return buildChangeContext('git-head', headText, document.getText());
  }

  const untracked = await execGit(['-C', gitFile.repoRoot, 'ls-files', '--others', '--exclude-standard', '--', gitFile.relativePath]).catch(() => '');
  if (untracked.trim()) {
    return buildChangeContext('git-head', '', document.getText());
  }

  return undefined;
}

async function loadLastCommitChange(document: vscode.TextDocument): Promise<DetectedChangeContext | undefined> {
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
  return buildChangeContext('last-commit', previousText, currentHeadText);
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
        : source === 'last-commit'
          ? 'Latest commit vs previous commit'
          : 'Changes vs git HEAD',
    range: formatLineRange(startLine + 1, endLine + 1),
    lineCount: Math.max(currentChangedLines.length, previousChangedLines.length, 1),
    currentSnippet,
    previousSnippet,
    startLine,
    endLine,
  };
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

function buildFocusSnippet(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  focusSymbol?: FlatSymbol,
  changeContext?: DetectedChangeContext,
): string {
  if (!selection.isEmpty) {
    return sanitizeSnippet(document.getText(selection));
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
