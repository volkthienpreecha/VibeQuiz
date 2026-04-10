import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractQuizContextFromDocumentDiff } from './contextExtractor';
import { ChangeChunk, ExtractionResult, QuizContext, SessionInfo } from './types';

const SESSION_KEY = 'vibeQuiz.activeSession';
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 1024 * 1024;
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

interface SessionBaselineFile {
  filePath: string;
  fileName: string;
  content: string;
}

export interface VibeQuizSession {
  id: string;
  startedAt: string;
  workspacePath: string;
  workspaceName: string;
  repoRoot?: string;
  startHead?: string;
  baselineFiles: SessionBaselineFile[];
  touchedFiles: string[];
}

export function getActiveSession(workspaceState: vscode.Memento): VibeQuizSession | undefined {
  const session = workspaceState.get<VibeQuizSession>(SESSION_KEY);
  if (!session) {
    return undefined;
  }

  return {
    ...session,
    baselineFiles: session.baselineFiles ?? [],
    touchedFiles: session.touchedFiles ?? [],
  };
}

export async function saveActiveSession(
  workspaceState: vscode.Memento,
  session: VibeQuizSession | undefined,
): Promise<void> {
  await workspaceState.update(SESSION_KEY, session);
}

export function resolveSessionWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const editorFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (editorFolder) {
      return editorFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

export async function createSessionSnapshot(workspaceFolder: vscode.WorkspaceFolder): Promise<VibeQuizSession> {
  const repoRoot = await resolveRepoRoot(workspaceFolder.uri.fsPath);
  const startHead = repoRoot
    ? await execGit(['-C', repoRoot, 'rev-parse', 'HEAD']).catch(() => undefined)
    : undefined;
  const baselinePaths = new Set<string>();

  if (repoRoot) {
    for (const filePath of await collectWorkingTreeFiles(repoRoot)) {
      if (isPathInsideFolder(filePath, workspaceFolder.uri.fsPath) && isSupportedSourceFile(filePath)) {
        baselinePaths.add(filePath);
      }
    }
  }

  for (const document of vscode.workspace.textDocuments) {
    if (
      document.isDirty &&
      document.uri.scheme === 'file' &&
      isPathInsideFolder(document.uri.fsPath, workspaceFolder.uri.fsPath) &&
      isSupportedSourceFile(document.uri.fsPath)
    ) {
      baselinePaths.add(document.uri.fsPath);
    }
  }

  const baselineFiles: SessionBaselineFile[] = [];
  for (const filePath of baselinePaths) {
    const content = await readCurrentWorkspaceText(filePath);
    baselineFiles.push({
      filePath,
      fileName: path.basename(filePath),
      content,
    });
  }

  return {
    id: `session-${Date.now()}`,
    startedAt: new Date().toISOString(),
    workspacePath: workspaceFolder.uri.fsPath,
    workspaceName: workspaceFolder.name,
    repoRoot,
    startHead: startHead?.trim() || undefined,
    baselineFiles,
    touchedFiles: [],
  };
}

export function touchSessionFiles(
  session: VibeQuizSession | undefined,
  filePaths: string[],
): VibeQuizSession | undefined {
  if (!session) {
    return session;
  }

  const touched = new Set(session.touchedFiles);
  for (const filePath of filePaths) {
    if (!filePath || !isPathInsideFolder(filePath, session.workspacePath) || !isSupportedSourceFile(filePath)) {
      continue;
    }

    touched.add(filePath);
  }

  return {
    ...session,
    touchedFiles: Array.from(touched),
  };
}

export async function buildSessionQuizContext(
  session: VibeQuizSession,
  onProgress?: (update: { progress: number; stage: string; detail?: string }) => void,
): Promise<ExtractionResult> {
  onProgress?.({
    progress: 16,
    stage: 'Loading session',
    detail: `${session.workspaceName} / started ${new Date(session.startedAt).toLocaleTimeString()}`,
  });

  const candidatePaths = await collectSessionCandidateFiles(session);
  if (candidatePaths.length === 0) {
    return {
      ok: false,
      message: 'No session changes were detected yet. Start a session, make some edits, then quiz it.',
    };
  }

  const baselineByPath = new Map(session.baselineFiles.map((file) => [file.filePath, file]));
  const fileContexts: QuizContext[] = [];
  const totalFiles = candidatePaths.length;

  for (let index = 0; index < candidatePaths.length; index += 1) {
    const filePath = candidatePaths[index];
    onProgress?.({
      progress: 22 + Math.round((index / Math.max(totalFiles, 1)) * 34),
      stage: 'Reading session changes',
      detail: path.basename(filePath),
    });

    const currentDocument = await openExistingTextDocument(filePath);
    if (!currentDocument) {
      continue;
    }

    const previousText = await resolveBaselineText(session, filePath, baselineByPath.get(filePath));
    const context = await extractQuizContextFromDocumentDiff({
      document: currentDocument,
      previousText,
      source: 'session',
      label: session.startHead ? `Session vs ${session.startHead.slice(0, 7)}` : 'Session changes',
      sessionInfo: buildSessionInfo(session, 0),
    });

    if (!context?.changeContext) {
      continue;
    }

    fileContexts.push(context);
  }

  if (fileContexts.length === 0) {
    return {
      ok: false,
      message: 'The session changes resolved to zero quizable source files. Save the files you changed and try again.',
    };
  }

  onProgress?.({
    progress: 60,
    stage: 'Ranking session chunks',
    detail: `${fileContexts.length} changed files`,
  });

  const aggregated = aggregateSessionContexts(session, fileContexts);
  onProgress?.({
    progress: 70,
    stage: 'Preparing session context',
    detail: `${aggregated.changeChunks?.length ?? 0} ranked chunks across ${aggregated.sessionInfo?.changedFileCount ?? fileContexts.length} files`,
  });

  return {
    ok: true,
    context: aggregated,
  };
}

function aggregateSessionContexts(session: VibeQuizSession, contexts: QuizContext[]): QuizContext {
  const combinedChunks = contexts
    .flatMap((context, fileIndex) =>
      (context.changeChunks ?? []).map((chunk, chunkIndex) => ({
        ...chunk,
        id: `session-${fileIndex + 1}-${chunkIndex + 1}`,
        label: formatSessionChunkLabel(chunk),
      })),
    )
    .sort((left, right) => right.score - left.score || (left.fileName ?? '').localeCompare(right.fileName ?? ''))
    .slice(0, 6);
  const topChunk = combinedChunks[0];
  const imports = Array.from(new Set(contexts.flatMap((context) => context.imports))).slice(0, 8);
  const exportsList = Array.from(new Set(contexts.flatMap((context) => context.exports))).slice(0, 8);
  const candidateFunctions = Array.from(new Set(contexts.flatMap((context) => context.candidateFunctions))).slice(0, 8);
  const totalChangedLines = contexts.reduce((sum, context) => sum + (context.changeContext?.lineCount ?? 0), 0);
  const languageValues = Array.from(new Set(contexts.map((context) => context.languageId)));
  const sessionInfo = buildSessionInfo(session, contexts.length);

  return {
    fileName: `${session.workspaceName} session`,
    filePath: session.workspacePath,
    languageId: languageValues.length === 1 ? languageValues[0] : 'mixed',
    lineCount: totalChangedLines,
    focusLabel: `${contexts.length} files changed this session`,
    focusKind: 'change',
    focusSnippet: topChunk?.currentSnippet ?? contexts[0].focusSnippet,
    symbolName: topChunk?.symbolName,
    imports,
    exports: exportsList,
    hasConditionals: contexts.some((context) => context.hasConditionals),
    hasValidation: contexts.some((context) => context.hasValidation),
    hasAsync: contexts.some((context) => context.hasAsync),
    hasErrorHandling: contexts.some((context) => context.hasErrorHandling),
    hasStateMutation: contexts.some((context) => context.hasStateMutation),
    candidateFunctions,
    changeContext: {
      source: 'session',
      type: 'modified',
      label: session.startHead ? `Session vs ${session.startHead.slice(0, 7)}` : 'Session changes',
      range: `${contexts.length} files`,
      lineCount: totalChangedLines,
      currentSnippet: topChunk?.currentSnippet ?? contexts[0].focusSnippet,
      previousSnippet: topChunk?.previousSnippet,
    },
    changeChunks: combinedChunks,
    isChunkedSession: true,
    sessionInfo,
  };
}

function buildSessionInfo(session: VibeQuizSession, changedFileCount: number): SessionInfo {
  return {
    id: session.id,
    startedAt: session.startedAt,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    baseRefLabel: session.startHead ? session.startHead.slice(0, 7) : 'local snapshot',
    touchedFileCount: session.touchedFiles.length,
    changedFileCount,
  };
}

function formatSessionChunkLabel(chunk: ChangeChunk): string {
  if (chunk.fileName && chunk.symbolName) {
    return `${chunk.fileName} / ${chunk.symbolName}`;
  }

  if (chunk.fileName) {
    return `${chunk.fileName} / ${chunk.label}`;
  }

  return chunk.label;
}

async function collectSessionCandidateFiles(session: VibeQuizSession): Promise<string[]> {
  const candidates = new Set<string>([
    ...session.touchedFiles,
    ...session.baselineFiles.map((file) => file.filePath),
  ]);

  if (session.repoRoot && session.startHead) {
    for (const filePath of await collectRepoDiffFilesSinceHead(session.repoRoot, session.startHead)) {
      if (isPathInsideFolder(filePath, session.workspacePath)) {
        candidates.add(filePath);
      }
    }
  }

  return Array.from(candidates)
    .filter((filePath) => isSupportedSourceFile(filePath))
    .sort();
}

async function collectRepoDiffFilesSinceHead(repoRoot: string, startHead: string): Promise<string[]> {
  const numstat = await execGit(['-C', repoRoot, 'diff', '--numstat', startHead, '--', '.']).catch(() => '');
  const untracked = await execGit(['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => '');
  return rankChangedFiles(repoRoot, parseGitNumstat(numstat), splitGitPaths(untracked));
}

async function resolveBaselineText(
  session: VibeQuizSession,
  filePath: string,
  baselineFile?: SessionBaselineFile,
): Promise<string> {
  if (baselineFile) {
    return baselineFile.content;
  }

  if (session.repoRoot && session.startHead) {
    const relativePath = toGitRelativePath(session.repoRoot, filePath);
    if (relativePath) {
      return execGit(['-C', session.repoRoot, 'show', `${session.startHead}:${relativePath}`]).catch(() => '');
    }
  }

  return '';
}

async function openExistingTextDocument(filePath: string): Promise<vscode.TextDocument | undefined> {
  const existing = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath === filePath);
  if (existing) {
    return existing;
  }

  try {
    return await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  } catch {
    return undefined;
  }
}

async function readCurrentWorkspaceText(filePath: string): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath === filePath);
  if (openDocument) {
    return openDocument.getText();
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

async function resolveRepoRoot(startPath: string): Promise<string | undefined> {
  return execGit(['-C', startPath, 'rev-parse', '--show-toplevel']).then((value) => value.trim()).catch(() => undefined);
}

async function collectWorkingTreeFiles(repoRoot: string): Promise<string[]> {
  const numstat = await execGit(['-C', repoRoot, 'diff', '--numstat', 'HEAD', '--', '.']).catch(() => '');
  const untracked = await execGit(['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => '');
  return rankChangedFiles(repoRoot, parseGitNumstat(numstat), splitGitPaths(untracked));
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

function splitGitPaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSupportedSourceFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return !BLOCKED_EXTENSIONS.has(extension);
}

function isPathInsideFolder(filePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
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
