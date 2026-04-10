import * as vscode from 'vscode';
import { createModeStatus, getAiSettings, getLaunchSettings, requiresApiKey, sourceModeLabel } from './config';
import { extractQuizContext } from './contextExtractor';
import { getApiKey } from './secrets';
import { getActiveSession } from './session';
import { getQuizStats } from './storage';

interface SidebarState {
  modeLabel: string;
  modeDetail: string;
  modeToggleCommand: string;
  modeToggleLabel: string;
  providerLabel: string;
  providerModel: string;
  providerStatus: string;
  sourceModeLabel: string;
  sourceDescription: string;
  sessionActive: boolean;
  sessionLabel: string;
  sessionDetail: string;
  sessionPrimaryCommand: string;
  sessionPrimaryLabel: string;
  selectedFileLabel: string;
  selectedFolderLabel: string;
  gitRangeLabel: string;
  activeFile: string;
  activeFocus: string;
  activeMeta: string;
  activeHint: string;
  quizzesTaken: number;
  streak: number;
  lastQuizLabel: string;
  weakAreas: string[];
}

const SIDEBAR_VIEW_ID = 'vibeQuiz.sidebar';
const COMMANDS = new Set([
  'vibeQuiz.quizMe',
  'vibeQuiz.startSession',
  'vibeQuiz.endSession',
  'vibeQuiz.setApiKey',
  'vibeQuiz.selectAiProvider',
  'vibeQuiz.openSettings',
  'vibeQuiz.enableAiMode',
  'vibeQuiz.useHeuristicMode',
  'vibeQuiz.selectSourceFile',
  'vibeQuiz.useCurrentFile',
  'vibeQuiz.selectSourceMode',
  'vibeQuiz.selectWorkspaceFolder',
  'vibeQuiz.setGitDiffRange',
]);

export class VibeQuizSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = SIDEBAR_VIEW_ID;

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshHandle?: NodeJS.Timeout;

  public constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh(180);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vibeQuiz')) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  public dispose(): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
      this.refreshHandle = undefined;
    }

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media')],
    };

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    }, null, this.disposables);

    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message as { type?: string; command?: string });
    }, null, this.disposables);

    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const webview = this.view.webview;
    const state = await this.buildState();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'sidebar.js'));
    const nonce = getNonce();
    const stateJson = JSON.stringify(state).replace(/</g, '\\u003c');

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>VibeQuiz</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">window.__VIBEQUIZ_SIDEBAR_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private scheduleRefresh(delay = 120): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
    }

    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = undefined;
      void this.refresh();
    }, delay);
  }

  private async handleMessage(message: { type?: string; command?: string }): Promise<void> {
    if (message.type === 'refresh') {
      await this.refresh();
      return;
    }

    if (message.type !== 'runCommand' || !message.command || !COMMANDS.has(message.command)) {
      return;
    }

    await vscode.commands.executeCommand(message.command);
    await this.refresh();
  }

  private async buildState(): Promise<SidebarState> {
    const settings = getAiSettings();
    const launchSettings = getLaunchSettings();
    const providerNeedsKey = requiresApiKey(settings);
    const apiKey = await getApiKey(this.extensionContext.secrets, settings.provider);
    const modeStatus = createModeStatus(settings, Boolean(apiKey) || !providerNeedsKey);
    const stats = getQuizStats(this.extensionContext.globalState);
    const activeSession = getActiveSession(this.extensionContext.workspaceState);
    const extraction = await extractQuizContext({
      sourceMode: launchSettings.sourceMode,
      selectedFilePath: launchSettings.selectedFile,
      workspaceFolderPath: launchSettings.workspaceFolder,
      gitBaseRef: launchSettings.gitBaseRef,
      gitHeadRef: launchSettings.gitHeadRef,
    });

    if (!extraction.ok) {
      return {
        modeLabel: modeStatus.label,
        modeDetail: modeStatus.detail,
        modeToggleCommand: settings.mode === 'ai' ? 'vibeQuiz.useHeuristicMode' : 'vibeQuiz.enableAiMode',
        modeToggleLabel: settings.mode === 'ai' ? 'Use Heuristic Mode' : 'Enable AI Mode',
        providerLabel: modeStatus.provider ? providerTitle(modeStatus.provider) : 'Local only',
        providerModel: modeStatus.mode === 'ai' ? modeStatus.model ?? settings.model : 'No model required',
        providerStatus: providerNeedsKey
          ? apiKey
            ? 'Key locked in VS Code Secret Storage'
            : 'Secure BYOK not configured yet'
          : 'This endpoint can run without a stored key',
        sourceModeLabel: sourceModeLabel(launchSettings.sourceMode),
        sourceDescription: describeSourceMode(launchSettings.sourceMode),
        sessionActive: Boolean(activeSession),
        sessionLabel: activeSession ? `Started ${formatSessionTime(activeSession.startedAt)}` : 'No active session',
        sessionDetail: activeSession
          ? `${activeSession.touchedFiles.length} touched file${activeSession.touchedFiles.length === 1 ? '' : 's'} in ${activeSession.workspaceName}`
          : 'Start a manual vibe-coding session to quiz the changes made after that point.',
        sessionPrimaryCommand: activeSession ? 'vibeQuiz.endSession' : 'vibeQuiz.startSession',
        sessionPrimaryLabel: activeSession ? 'Quiz Session' : 'Start Session',
        selectedFileLabel: resolvePathLabel(launchSettings.selectedFile, 'Auto'),
        selectedFolderLabel: resolveFolderLabel(launchSettings.workspaceFolder),
        gitRangeLabel: `${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`,
        activeFile: 'No active code file',
        activeFocus: 'Open a code file to warm up the launcher.',
        activeMeta: 'Command, status bar, or title button',
        activeHint: extraction.message,
        quizzesTaken: stats.quizzesTaken,
        streak: stats.streak,
        lastQuizLabel: formatLastQuiz(stats.lastQuizAt),
        weakAreas: stats.recentWeakAreas,
      };
    }

    const context = extraction.context;
    const focusMeta = context.isChunkedSession && context.changeChunks?.length
      ? `${context.changeChunks.length} ranked chunks - top ${context.changeChunks[0].range}`
      : context.changeContext
        ? `${context.changeContext.label} - ${context.changeContext.range}`
        : context.selectionRange
          ? `${context.selectionRange} - selection`
          : `${context.lineCount} lines - ${context.languageId}`;
    const focusHint = context.isChunkedSession && context.changeChunks?.length
      ? 'Large changes are split into ranked chunks so the quiz can stay grounded.'
      : context.changeContext
        ? 'Questions will prioritize the code you changed most recently.'
        : context.selectionText
          ? 'Questions will lock onto the selection before looking at the rest of the file.'
          : 'Questions will use the nearest symbol or the active file when context is weak.';

    return {
      modeLabel: modeStatus.label,
      modeDetail: modeStatus.detail,
      modeToggleCommand: settings.mode === 'ai' ? 'vibeQuiz.useHeuristicMode' : 'vibeQuiz.enableAiMode',
      modeToggleLabel: settings.mode === 'ai' ? 'Use Heuristic Mode' : 'Enable AI Mode',
      providerLabel: modeStatus.provider ? providerTitle(modeStatus.provider) : 'Local only',
      providerModel: modeStatus.mode === 'ai' ? modeStatus.model ?? settings.model : 'Heuristic engine',
      providerStatus: providerNeedsKey
        ? apiKey
          ? 'Key locked in VS Code Secret Storage'
          : 'Secure BYOK not configured yet'
        : 'This endpoint can run without a stored key',
      sourceModeLabel: sourceModeLabel(launchSettings.sourceMode),
      sourceDescription: describeSourceMode(launchSettings.sourceMode),
      sessionActive: Boolean(activeSession),
      sessionLabel: activeSession ? `Started ${formatSessionTime(activeSession.startedAt)}` : 'No active session',
      sessionDetail: activeSession
        ? `${activeSession.touchedFiles.length} touched file${activeSession.touchedFiles.length === 1 ? '' : 's'} in ${activeSession.workspaceName}`
        : 'Start a manual vibe-coding session to quiz the changes made after that point.',
      sessionPrimaryCommand: activeSession ? 'vibeQuiz.endSession' : 'vibeQuiz.startSession',
      sessionPrimaryLabel: activeSession ? 'Quiz Session' : 'Start Session',
      selectedFileLabel: resolvePathLabel(launchSettings.selectedFile, 'Auto'),
      selectedFolderLabel: resolveFolderLabel(launchSettings.workspaceFolder),
      gitRangeLabel: `${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`,
      activeFile: context.fileName,
      activeFocus: context.focusLabel,
      activeMeta: focusMeta,
      activeHint: focusHint,
      quizzesTaken: stats.quizzesTaken,
      streak: stats.streak,
      lastQuizLabel: formatLastQuiz(stats.lastQuizAt),
      weakAreas: stats.recentWeakAreas,
    };
  }
}

function providerTitle(provider: NonNullable<ReturnType<typeof getAiSettings>['provider']>): string {
  switch (provider) {
    case 'anthropic':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'openaiCompatible':
      return 'OpenAI-compatible';
    case 'openai':
    default:
      return 'OpenAI';
  }
}

function describeSourceMode(sourceMode: ReturnType<typeof getLaunchSettings>['sourceMode']): string {
  switch (sourceMode) {
    case 'selectedFile':
      return 'Pin one file and VibeQuiz will keep quizzing that file until you choose a different source.';
    case 'workspaceFolder':
      return 'Pick a folder and VibeQuiz will choose a changed source file inside it.';
    case 'gitRange':
      return 'Pick a folder and commit refs. VibeQuiz will compare that range and choose a changed file.';
    case 'currentFile':
    default:
      return 'Default mode. Start with the active editor, then fall back to recent workspace changes or the latest commit diff.';
  }
}

function resolveFolderLabel(configuredPath: string): string {
  return resolvePathLabel(configuredPath, 'Auto');
}

function resolvePathLabel(configuredPath: string, fallback: string): string {
  if (!configuredPath) {
    return fallback;
  }

  return configuredPath.split(/[\\/]/).pop() || configuredPath;
}

function formatLastQuiz(value?: string): string {
  if (!value) {
    return 'No sessions yet';
  }

  const lastQuiz = new Date(value);
  if (Number.isNaN(lastQuiz.getTime())) {
    return 'No sessions yet';
  }

  const now = new Date();
  const deltaMs = now.getTime() - lastQuiz.getTime();
  const deltaHours = Math.floor(deltaMs / (60 * 60 * 1000));
  const deltaDays = Math.floor(deltaHours / 24);

  if (deltaHours < 1) {
    return 'Just now';
  }

  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  if (deltaDays < 7) {
    return `${deltaDays}d ago`;
  }

  return lastQuiz.toLocaleDateString();
}

function formatSessionTime(value: string): string {
  const startedAt = new Date(value);
  if (Number.isNaN(startedAt.getTime())) {
    return 'just now';
  }

  return startedAt.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}
