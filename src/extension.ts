import * as vscode from 'vscode';
import { generateAiQuizQuestions } from './aiClient';
import {
  createModeStatus,
  getAiSettings,
  getLaunchSettings,
  getDefaultBaseUrl,
  getDefaultModel,
  providerLabel,
  requiresApiKey,
  setAiBaseUrl,
  setAiModel,
  setAiProvider,
  setQuizMode,
  setGitDiffRange,
  setSelectedFilePath,
  setSourceMode,
  setWorkspaceFolderPath,
  sourceModeLabel,
} from './config';
import { extractQuizContext } from './contextExtractor';
import { generateReflection } from './feedback';
import { VibeQuizPanel } from './panel';
import { generateQuizQuestions } from './quizGenerator';
import { clearApiKey, getApiKey, promptAndStoreApiKey } from './secrets';
import {
  buildSessionQuizContext,
  createSessionSnapshot,
  getActiveSession,
  resolveSessionWorkspaceFolder,
  saveActiveSession,
  touchSessionFiles,
  VibeQuizSession,
} from './session';
import { VibeQuizSidebarProvider } from './sidebar';
import { getQuizStats, recordQuiz } from './storage';
import { AiProvider, PanelState } from './types';

const ONBOARDING_KEY = 'vibeQuiz.onboardingShown';

interface ExtractionAttempt {
  sourceMode: ReturnType<typeof getLaunchSettings>['sourceMode'];
  label: string;
}

export function activate(extensionContext: vscode.ExtensionContext): void {
  const sidebarProvider = new VibeQuizSidebarProvider(extensionContext);
  const statusBarItem = createStatusBarItem();
  let activeSession = getActiveSession(extensionContext.workspaceState);
  let sessionPersistHandle: NodeJS.Timeout | undefined;
  const scheduleSessionPersist = (): void => {
    if (sessionPersistHandle) {
      clearTimeout(sessionPersistHandle);
    }

    sessionPersistHandle = setTimeout(() => {
      sessionPersistHandle = undefined;
      void saveActiveSession(extensionContext.workspaceState, activeSession);
    }, 180);
  };
  const setActiveSession = (nextSession: VibeQuizSession | undefined, persistImmediately = false): void => {
    activeSession = nextSession;
    if (persistImmediately) {
      if (sessionPersistHandle) {
        clearTimeout(sessionPersistHandle);
        sessionPersistHandle = undefined;
      }

      void saveActiveSession(extensionContext.workspaceState, activeSession);
    } else {
      scheduleSessionPersist();
    }
  };
  const markSessionTouchedPaths = (paths: string[]): void => {
    const nextSession = touchSessionFiles(activeSession, paths);
    if (nextSession === activeSession) {
      return;
    }

    activeSession = nextSession;
    scheduleSessionPersist();
    refreshChrome();
  };
  const refreshChrome = (): void => {
    updateStatusBarItem(statusBarItem, activeSession);
    void sidebarProvider.refresh();
  };

  extensionContext.subscriptions.push(
    sidebarProvider,
    vscode.window.registerWebviewViewProvider(VibeQuizSidebarProvider.viewId, sidebarProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    statusBarItem,
    vscode.window.onDidChangeActiveTextEditor(refreshChrome),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        refreshChrome();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file') {
        markSessionTouchedPaths([event.document.uri.fsPath]);
      }

      if (event.document === vscode.window.activeTextEditor?.document) {
        refreshChrome();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') {
        markSessionTouchedPaths([document.uri.fsPath]);
      }

      if (document === vscode.window.activeTextEditor?.document) {
        refreshChrome();
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      markSessionTouchedPaths(event.files.map((file) => file.fsPath));
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      markSessionTouchedPaths(event.files.map((file) => file.fsPath));
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      markSessionTouchedPaths(event.files.flatMap((file) => [file.oldUri.fsPath, file.newUri.fsPath]));
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vibeQuiz')) {
        refreshChrome();
      }
    }),
    vscode.commands.registerCommand('vibeQuiz.quizMe', async () => {
      await openQuizPanel(extensionContext, sidebarProvider, activeSession, async () => {
        setActiveSession(undefined, true);
        refreshChrome();
      });
    }),
    vscode.commands.registerCommand('vibeQuiz.startSession', async () => {
      const workspaceFolder = resolveSessionWorkspaceFolder();
      if (!workspaceFolder) {
        void vscode.window.showWarningMessage('Open a workspace folder before starting a VibeQuiz session.');
        return;
      }

      const nextSession = await createSessionSnapshot(workspaceFolder);
      setActiveSession(nextSession, true);
      refreshChrome();
      void vscode.window.showInformationMessage(
        `VibeQuiz session started in ${workspaceFolder.name}. ${nextSession.startHead ? `Baseline ${nextSession.startHead.slice(0, 7)}.` : 'Using a local snapshot baseline.'}`,
      );
    }),
    vscode.commands.registerCommand('vibeQuiz.endSession', async () => {
      if (!activeSession) {
        void vscode.window.showWarningMessage('No VibeQuiz session is active yet. Run "VibeQuiz: Start Session" first.');
        return;
      }

      await openQuizPanel(extensionContext, sidebarProvider, activeSession, async () => {
        setActiveSession(undefined, true);
        refreshChrome();
      });
    }),
    vscode.commands.registerCommand('vibeQuiz.setApiKey', async () => {
      const settings = getAiSettings();
      await promptAndStoreApiKey(extensionContext.secrets, settings.provider);
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.clearApiKey', async () => {
      const settings = getAiSettings();
      const cleared = await clearApiKey(extensionContext.secrets, settings.provider);
      if (!cleared) {
        return;
      }

      if (getAiSettings().mode === 'ai') {
        const action = await vscode.window.showWarningMessage(
          'AI mode is still enabled, but no API key is stored now.',
          'Switch to Heuristic Mode',
          'Open Settings',
        );

        if (action === 'Switch to Heuristic Mode') {
          await setQuizMode('heuristic');
          void vscode.window.showInformationMessage('VibeQuiz switched back to heuristic mode.');
        }

        if (action === 'Open Settings') {
          await vscode.commands.executeCommand('vibeQuiz.openSettings');
        }
      }

      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.enableAiMode', async () => {
      const settings = getAiSettings();
      const key = await getApiKey(extensionContext.secrets, settings.provider);
      const providerNeedsKey = requiresApiKey(settings);

      if (providerNeedsKey && !key) {
        const saved = await promptAndStoreApiKey(extensionContext.secrets, settings.provider);
        if (!saved) {
          return;
        }
      }

      await setQuizMode('ai');
      void vscode.window.showInformationMessage('VibeQuiz AI mode enabled.');
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.useHeuristicMode', async () => {
      await setQuizMode('heuristic');
      void vscode.window.showInformationMessage('VibeQuiz is using local heuristic mode.');
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.selectAiProvider', async () => {
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: 'OpenAI',
            description: 'Responses API with structured outputs',
            provider: 'openai' as const,
          },
          {
            label: 'Anthropic Claude',
            description: 'Messages API with tool-enforced structured output',
            provider: 'anthropic' as const,
          },
          {
            label: 'Google Gemini',
            description: 'Gemini structured JSON responses',
            provider: 'gemini' as const,
          },
          {
            label: 'OpenAI-compatible',
            description: 'Ollama, OpenRouter, Together, Groq, Fireworks, LM Studio, and similar',
            provider: 'openaiCompatible' as const,
          },
        ],
        {
          title: 'VibeQuiz - Select AI Provider',
          matchOnDescription: true,
          ignoreFocusOut: true,
        },
      );

      if (!selected) {
        return;
      }

      await configureProvider(selected.provider);
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.setAiModel', async () => {
      const settings = getAiSettings();
      const nextModel = await vscode.window.showInputBox({
        title: 'VibeQuiz - Set AI Model',
        prompt: `Model name for ${providerLabel(settings.provider)}`,
        value: settings.model,
        ignoreFocusOut: true,
        placeHolder: getDefaultModel(settings.provider),
        validateInput: (input) => (input.trim() ? undefined : 'Model name cannot be empty.'),
      });

      if (nextModel === undefined) {
        return;
      }

      await setAiModel(nextModel);
      void vscode.window.showInformationMessage(`VibeQuiz model set to ${nextModel.trim()}.`);
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.selectSourceMode', async () => {
      const launchSettings = getLaunchSettings();
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: 'Smart Current',
            description: 'Start with the active editor, then fall back to recent workspace changes or the latest commit diff',
            sourceMode: 'currentFile' as const,
          },
          {
            label: 'Selected File',
            description: 'Pin one file and always quiz that file until you change it',
            sourceMode: 'selectedFile' as const,
          },
          {
            label: 'Workspace Folder',
            description: 'Choose a folder and let VibeQuiz pick a changed source file',
            sourceMode: 'workspaceFolder' as const,
          },
          {
            label: 'Git Commit Range',
            description: 'Choose a folder and compare two refs to pick a changed source file',
            sourceMode: 'gitRange' as const,
          },
        ],
        {
          title: 'VibeQuiz - Select Launch Source',
          placeHolder: `Current: ${sourceModeLabel(launchSettings.sourceMode)}`,
          ignoreFocusOut: true,
          matchOnDescription: true,
        },
      );

      if (!selected) {
        return;
      }

      await setSourceMode(selected.sourceMode);

      if (selected.sourceMode === 'selectedFile' && !getLaunchSettings().selectedFile) {
        await pickSourceFile();
      }

      if ((selected.sourceMode === 'workspaceFolder' || selected.sourceMode === 'gitRange') && !getLaunchSettings().workspaceFolder) {
        await pickWorkspaceFolder();
      }

      if (selected.sourceMode === 'gitRange') {
        await promptForGitDiffRange();
      }

      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.selectWorkspaceFolder', async () => {
      await pickWorkspaceFolder();
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.selectSourceFile', async () => {
      await pickSourceFile();
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.useCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('Open a source file first, then run "VibeQuiz: Use Current File".');
        return;
      }

      await setSelectedFilePath(editor.document.uri.fsPath);
      await setSourceMode('selectedFile');
      void vscode.window.showInformationMessage(`VibeQuiz will use ${editor.document.fileName.split(/[\\/]/).pop() ?? 'the current file'} until you change the source.`);
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.setGitDiffRange', async () => {
      await promptForGitDiffRange();
      refreshChrome();
    }),
    vscode.commands.registerCommand('vibeQuiz.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'vibeQuiz.ai.provider');
    }),
  );

  async function configureProvider(provider: AiProvider): Promise<void> {
    await setAiProvider(provider);
    await setAiModel(getDefaultModel(provider));
    await setAiBaseUrl(getDefaultBaseUrl(provider));

    const settings = getAiSettings();
    const providerNeedsKey = requiresApiKey(settings);
    const key = await getApiKey(extensionContext.secrets, provider);

    if (providerNeedsKey && !key) {
      const action = await vscode.window.showInformationMessage(
        `${providerLabel(provider)} selected. This provider needs an API key stored securely before AI mode can run.`,
        'Set API Key',
        'Open Settings',
      );

      if (action === 'Set API Key') {
        await promptAndStoreApiKey(extensionContext.secrets, provider);
      }

      if (action === 'Open Settings') {
        await vscode.commands.executeCommand('vibeQuiz.openSettings');
      }

      return;
    }

    const suffix = providerNeedsKey
      ? `Model ${settings.model} is ready.`
      : `Model ${settings.model} is ready, and this endpoint can run without a stored key.`;

    void vscode.window.showInformationMessage(`${providerLabel(provider)} selected. ${suffix}`);
  }

  async function pickWorkspaceFolder(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('Open a workspace folder before using folder or git-range launch modes.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        value: folder.uri.fsPath,
      })),
      {
        title: 'VibeQuiz - Select Workspace Folder',
        ignoreFocusOut: true,
      },
    );

    if (!selected) {
      return;
    }

    await setWorkspaceFolderPath(selected.value);
  }

  async function pickSourceFile(): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const defaultUri = activeEditor?.document.uri.scheme === 'file'
      ? vscode.Uri.file(activeEditor.document.uri.fsPath)
      : workspaceFolders[0]?.uri;

    const picked = await vscode.window.showOpenDialog({
      title: 'VibeQuiz - Select Source File',
      defaultUri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use This File',
      filters: {
        'Source Files': ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'cs', 'php', 'rb', 'swift', 'scala', 'vue', 'svelte', 'html', 'css', 'scss', 'json'],
        'All Files': ['*'],
      },
    });

    const selected = picked?.[0];
    if (!selected) {
      return;
    }

    await setSelectedFilePath(selected.fsPath);
  }

  async function promptForGitDiffRange(): Promise<void> {
    const launchSettings = getLaunchSettings();
    const baseRef = await vscode.window.showInputBox({
      title: 'VibeQuiz - Git Base Ref',
      prompt: 'Base commit or ref for the diff range',
      value: launchSettings.gitBaseRef,
      ignoreFocusOut: true,
      placeHolder: 'HEAD~1',
      validateInput: (input) => (input.trim() ? undefined : 'Base ref cannot be empty.'),
    });

    if (baseRef === undefined) {
      return;
    }

    const headRef = await vscode.window.showInputBox({
      title: 'VibeQuiz - Git Head Ref',
      prompt: 'Head commit or ref for the diff range',
      value: launchSettings.gitHeadRef,
      ignoreFocusOut: true,
      placeHolder: 'HEAD',
      validateInput: (input) => (input.trim() ? undefined : 'Head ref cannot be empty.'),
    });

    if (headRef === undefined) {
      return;
    }

    await setGitDiffRange(baseRef, headRef);
  }

  updateStatusBarItem(statusBarItem, activeSession);
  void maybeShowOnboarding(extensionContext, sidebarProvider);
}

export function deactivate(): void {
  // No-op.
}

async function openQuizPanel(
  extensionContext: vscode.ExtensionContext,
  sidebarProvider?: VibeQuizSidebarProvider,
  activeSession?: VibeQuizSession,
  onSessionConsumed?: () => Promise<void>,
): Promise<void> {
  const stats = getQuizStats(extensionContext.globalState);
  const settings = getAiSettings();
  const launchSettings = getLaunchSettings();
  const storedKey = await getApiKey(extensionContext.secrets, settings.provider);
  const providerNeedsKey = requiresApiKey(settings);
  let modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey);
  const launchAttempts = activeSession ? [] : buildExtractionAttempts(launchSettings);
  const loadingDetails = [
    activeSession
      ? 'Loading tracked session files'
      : launchAttempts[0].label,
    activeSession
      ? 'Diffing current code against the session baseline'
      : launchAttempts.length > 1
        ? 'Falling back to recent repo changes if needed'
        : 'Resolving the requested quiz source',
    settings.mode === 'ai' ? 'Generating multiple-choice questions' : 'Building local multiple-choice questions',
    'Finishing the quiz panel',
  ];

  const showLoading = (progressValue: number, stage: string, detail?: string): void => {
    VibeQuizPanel.render(
      extensionContext,
      {
        kind: 'loading',
        title: 'VibeQuiz',
        subtitle: 'Setting up your quiz.',
        modeStatus,
        stats,
        loadingProgress: progressValue,
        loadingStage: stage,
        loadingDetail: detail,
        loadingDetails: loadingDetails,
      },
      async () => ({
        feedback: [],
        stats,
        summary: { correct: 0, total: 0, skipped: 0 },
      }),
    );
  };

  try {
    showLoading(6, activeSession ? 'Opening session diff' : 'Opening session', activeSession ? activeSession.workspaceName : launchAttempts[0].label);
    const extractionResult = activeSession
      ? {
          result: await buildSessionQuizContext(activeSession, ({ progress, stage, detail }) => {
            showLoading(progress, stage, detail);
          }),
          effectiveSourceMode: 'workspaceFolder' as const,
        }
      : await extractQuizContextWithFallback(
          launchSettings,
          ({ progress, stage, detail }) => {
            showLoading(progress, stage, detail);
          },
        );
    const extraction = extractionResult.result;
    if (!extraction.ok) {
      renderEmptyPanel(extensionContext, stats, modeStatus, extraction.message);
      return;
    }

    const context = extraction.context;
    const effectiveSourceMode = extractionResult.effectiveSourceMode;
    if (activeSession && onSessionConsumed) {
      await onSessionConsumed();
    }

    if (settings.mode === 'ai' && providerNeedsKey && !storedKey) {
      const action = await vscode.window.showWarningMessage(
        'AI mode is enabled, but no API key is stored securely yet.',
        'Set API Key',
        'Use Heuristic Mode',
      );

      if (action === 'Set API Key') {
        const saved = await promptAndStoreApiKey(extensionContext.secrets, settings.provider);
        if (saved) {
          await vscode.commands.executeCommand('vibeQuiz.quizMe');
        }
        return;
      }

      if (action === 'Use Heuristic Mode') {
        await setQuizMode('heuristic');
        await vscode.commands.executeCommand('vibeQuiz.quizMe');
        return;
      }

      renderEmptyPanel(
        extensionContext,
        stats,
        modeStatus,
        'AI mode needs a stored API key. Run "VibeQuiz: Set API Key" or switch back to heuristic mode.',
      );
      return;
    }

    showLoading(
      58,
      'Change detected',
      effectiveSourceMode === 'gitRange'
        ? `${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`
        : sourceModeLabel(effectiveSourceMode),
    );
    showLoading(
      72,
      'Planning question set',
      effectiveSourceMode === launchSettings.sourceMode
        ? `Using ${sourceModeLabel(effectiveSourceMode)}`
        : `Fell back to ${sourceModeLabel(effectiveSourceMode)}`,
    );
    showLoading(
      82,
      'Building questions',
      settings.mode === 'ai'
        ? 'Calling the selected model in the extension host'
        : 'Generating local answer choices and explanations',
    );
    let questions = generateQuizQuestions(context);
    let sessionUsesAi = settings.mode === 'ai' && (!providerNeedsKey || Boolean(storedKey));
    const sessionApiKey = storedKey ?? '';

    if (context.sessionInfo) {
      modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey, sessionUsesAi
        ? {
            label: `AI session mode - ${providerLabel(settings.provider)}`,
            detail: `Questions are being generated from the tracked session diff across ${context.sessionInfo.changedFileCount} files.`,
          }
        : {
            label: 'Session mode - heuristic',
            detail: `Questions are generated locally from the tracked session diff across ${context.sessionInfo.changedFileCount} files.`,
          });
    }

    if (sessionUsesAi) {
      try {
        questions = await generateAiQuizQuestions(context, settings, sessionApiKey);
        modeStatus = context.sessionInfo
          ? createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey, {
              label: `AI session mode - ${providerLabel(settings.provider)}`,
              detail: `Questions were generated from the tracked session diff across ${context.sessionInfo.changedFileCount} files.`,
            })
          : createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'AI question generation failed.';
        modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey, {
          mode: 'heuristic',
          label: context.sessionInfo ? 'AI session mode - heuristic fallback' : 'AI mode - heuristic fallback',
          detail: `${detail} VibeQuiz fell back to local heuristics for this session.`,
        });
        sessionUsesAi = false;
        void vscode.window.showWarningMessage(
          `${detail} VibeQuiz used local heuristics instead for this session.`,
        );
      }
    }

    showLoading(94, 'Finishing', 'Rendering the quiz panel');

    const panelState: PanelState = {
      kind: 'quiz',
      title: 'VibeQuiz',
      subtitle: context.sessionInfo
        ? `Five session-aware multiple-choice checks across ${context.sessionInfo.changedFileCount} changed files.`
        : context.isChunkedSession
        ? `Five multiple-choice checks across ${context.changeChunks?.length ?? 0} ranked change chunks.`
        : effectiveSourceMode === 'workspaceFolder'
          ? 'Five repo-aware multiple-choice checks across recent workspace changes.'
          : effectiveSourceMode === 'gitRange'
            ? `Five commit-aware multiple-choice checks across ${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}.`
            : context.changeContext
          ? sessionUsesAi
            ? 'Five diff-aware multiple-choice checks on your latest edits.'
            : 'Five quick multiple-choice checks on your latest edits.'
          : sessionUsesAi
            ? 'AI wrote the questions. Grading stays local and your key never reaches the webview.'
            : 'Five quick multiple-choice checks. No fake intelligence theater.',
      contextTag: context.sessionInfo
        ? `SESSION ${context.languageId.toUpperCase()}`
        : context.isChunkedSession
          ? `CHUNKED ${context.languageId.toUpperCase()}`
        : effectiveSourceMode === 'workspaceFolder'
          ? `REPO ${context.languageId.toUpperCase()}`
          : effectiveSourceMode === 'gitRange'
            ? `COMMIT ${context.languageId.toUpperCase()}`
            : context.languageId.toUpperCase(),
      modeStatus,
      quizContext: context,
      questions,
      stats,
    };

    VibeQuizPanel.render(extensionContext, panelState, async ({ answers }) => {
      const reflection = generateReflection(questions, answers);
      const updatedStats = await recordQuiz(extensionContext.globalState, reflection.weakAreas, reflection.chunkWeakAreas);
      await sidebarProvider?.refresh();

      return {
        feedback: reflection.feedback,
        stats: updatedStats,
        summary: reflection.summary,
        chunkWeakAreas: reflection.chunkWeakAreas,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error during quiz creation.';
    renderEmptyPanel(extensionContext, stats, modeStatus, `VibeQuiz hit a snag: ${message}`);
  }
}

async function extractQuizContextWithFallback(
  launchSettings: ReturnType<typeof getLaunchSettings>,
  onProgress: (update: { progress: number; stage: string; detail?: string }) => void,
): Promise<{
  result: Awaited<ReturnType<typeof extractQuizContext>>;
  effectiveSourceMode: ReturnType<typeof getLaunchSettings>['sourceMode'];
}> {
  const attempts = buildExtractionAttempts(launchSettings);
  let lastFailure: Awaited<ReturnType<typeof extractQuizContext>> | undefined;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (index > 0) {
      onProgress({
        progress: 48 + index * 4,
        stage: 'Switching source',
        detail: attempt.label,
      });
    }

    const extraction = await extractQuizContext({
      sourceMode: attempt.sourceMode,
      selectedFilePath: launchSettings.selectedFile,
      workspaceFolderPath: launchSettings.workspaceFolder,
      gitBaseRef: launchSettings.gitBaseRef,
      gitHeadRef: launchSettings.gitHeadRef,
      onProgress: ({ progress, stage, detail }) => {
        onProgress({
          progress: Math.max(10, Math.min(progress, 56)),
          stage,
          detail,
        });
      },
    });

    if (!extraction.ok) {
      lastFailure = extraction;
      continue;
    }

    if (shouldShowNoChangeState(extraction.context, attempt.sourceMode)) {
      lastFailure = {
        ok: false,
        message: noChangeMessageFor(attempt.sourceMode),
      };
      continue;
    }

    return {
      result: extraction,
      effectiveSourceMode: attempt.sourceMode,
    };
  }

  return {
    result: lastFailure ?? {
      ok: false,
      message: 'VibeQuiz could not find a useful source to quiz yet.',
    },
    effectiveSourceMode: launchSettings.sourceMode,
  };
}

function buildExtractionAttempts(
  launchSettings: ReturnType<typeof getLaunchSettings>,
): ExtractionAttempt[] {
  switch (launchSettings.sourceMode) {
    case 'workspaceFolder':
      return [
        {
          sourceMode: 'workspaceFolder',
          label: 'Scanning recent workspace changes',
        },
        {
          sourceMode: 'gitRange',
          label: `Checking commit diff ${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`,
        },
      ];
    case 'currentFile':
      return [
        {
          sourceMode: 'currentFile',
          label: 'Checking the active editor first',
        },
        {
          sourceMode: 'workspaceFolder',
          label: 'Falling back to recent workspace changes',
        },
        {
          sourceMode: 'gitRange',
          label: `Falling back to commit diff ${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`,
        },
      ];
    case 'selectedFile':
      return [
        {
          sourceMode: 'selectedFile',
          label: 'Opening the pinned source file',
        },
      ];
    case 'gitRange':
    default:
      return [
        {
          sourceMode: 'gitRange',
          label: `Checking commit diff ${launchSettings.gitBaseRef}..${launchSettings.gitHeadRef}`,
        },
      ];
  }
}

function shouldShowNoChangeState(
  context: NonNullable<PanelState['quizContext']>,
  sourceMode: ReturnType<typeof getLaunchSettings>['sourceMode'],
): boolean {
  if (sourceMode !== 'currentFile' && sourceMode !== 'selectedFile') {
    return false;
  }

  return !context.selectionText && !context.changeContext;
}

function noChangeMessageFor(sourceMode: ReturnType<typeof getLaunchSettings>['sourceMode']): string {
  if (sourceMode === 'selectedFile') {
    return 'No change detected in the selected file yet. Make an edit, select code in that file, or switch source mode.';
  }

  return 'No change detected yet. Make an edit, select code, or switch to folder or git-range mode.';
}

function renderEmptyPanel(
  extensionContext: vscode.ExtensionContext,
  stats: ReturnType<typeof getQuizStats>,
  modeStatus: PanelState['modeStatus'],
  emptyMessage: string,
): void {
  VibeQuizPanel.render(
    extensionContext,
    {
      kind: 'empty',
      title: 'VibeQuiz',
      subtitle: 'Quick multiple-choice recall for the code you just wrote.',
      modeStatus,
      emptyMessage,
      stats,
    },
    async () => ({
      feedback: [],
      stats,
      summary: {
        correct: 0,
        total: 0,
        skipped: 0,
      },
    }),
  );
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  item.name = 'VibeQuiz';
  item.command = 'vibeQuiz.quizMe';
  return item;
}

function updateStatusBarItem(item: vscode.StatusBarItem, activeSession?: VibeQuizSession): void {
  const editor = vscode.window.activeTextEditor;
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (!editor && !hasWorkspace) {
    item.hide();
    return;
  }

  if (editor && !['file', 'untitled'].includes(editor.document.uri.scheme)) {
    item.hide();
    return;
  }

  const mode = getAiSettings().mode === 'ai' ? 'AI' : 'Local';
  const sourceMode = sourceModeLabel(getLaunchSettings().sourceMode);
  const fileName = editor?.document.fileName
    ? editor.document.fileName.split(/[\\/]/).pop() ?? 'current file'
    : 'recent repo changes';
  const focusLabel = activeSession
    ? `quiz session from ${new Date(activeSession.startedAt).toLocaleTimeString()}`
    : editor
    ? editor.selection.isEmpty
      ? editor.document.isDirty
        ? 'quiz recent edits'
        : 'quiz this file'
      : 'quiz selection'
    : 'quiz recent changes';

  item.text = activeSession ? '$(pulse) Quiz Session' : '$(sparkle) Quiz Me';
  item.tooltip = activeSession
    ? `VibeQuiz\n${mode} mode\nActive session in ${activeSession.workspaceName}\n${focusLabel}`
    : `VibeQuiz\n${mode} mode\n${sourceMode}\n${focusLabel} in ${fileName}`;
  item.show();
}

async function maybeShowOnboarding(
  extensionContext: vscode.ExtensionContext,
  sidebarProvider: VibeQuizSidebarProvider,
): Promise<void> {
  const alreadyShown = extensionContext.globalState.get<boolean>(ONBOARDING_KEY, false);
  if (alreadyShown) {
    return;
  }

  await extensionContext.globalState.update(ONBOARDING_KEY, true);

  const settings = getAiSettings();
  const providerNeedsKey = requiresApiKey(settings);
  const existingKey = await getApiKey(extensionContext.secrets, settings.provider);
  if (!providerNeedsKey || existingKey) {
    return;
  }

  const action = await vscode.window.showInformationMessage(
    'VibeQuiz can run in local mode now, or you can set an API key once for AI-generated questions. The key is stored locally in VS Code Secret Storage.',
    'Set API Key',
    'Open Sidebar',
    'Stay Local',
  );

  if (action === 'Set API Key') {
    await promptAndStoreApiKey(extensionContext.secrets, settings.provider);
    return;
  }

  if (action === 'Open Sidebar') {
    await vscode.commands.executeCommand('workbench.view.extension.vibeQuiz');
    await vscode.commands.executeCommand('vibeQuiz.sidebar.focus');
    await sidebarProvider.refresh();
  }
}
