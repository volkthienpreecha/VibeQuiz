import * as vscode from 'vscode';
import { generateAiQuizQuestions } from './aiClient';
import {
  createModeStatus,
  getAiSettings,
  getDefaultBaseUrl,
  getDefaultModel,
  providerLabel,
  requiresApiKey,
  setAiBaseUrl,
  setAiModel,
  setAiProvider,
  setQuizMode,
} from './config';
import { extractQuizContext } from './contextExtractor';
import { generateReflection } from './feedback';
import { VibeQuizPanel } from './panel';
import { generateQuizQuestions } from './quizGenerator';
import { clearApiKey, getApiKey, promptAndStoreApiKey } from './secrets';
import { VibeQuizSidebarProvider } from './sidebar';
import { getQuizStats, recordQuiz } from './storage';
import { AiProvider, PanelState } from './types';

const ONBOARDING_KEY = 'vibeQuiz.onboardingShown';

export function activate(extensionContext: vscode.ExtensionContext): void {
  const sidebarProvider = new VibeQuizSidebarProvider(extensionContext);
  const statusBarItem = createStatusBarItem();
  const refreshChrome = (): void => {
    updateStatusBarItem(statusBarItem);
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
      if (event.document === vscode.window.activeTextEditor?.document) {
        refreshChrome();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document === vscode.window.activeTextEditor?.document) {
        refreshChrome();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vibeQuiz')) {
        refreshChrome();
      }
    }),
    vscode.commands.registerCommand('vibeQuiz.quizMe', async () => {
      await openQuizPanel(extensionContext, sidebarProvider);
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

  updateStatusBarItem(statusBarItem);
  void maybeShowOnboarding(extensionContext, sidebarProvider);
}

export function deactivate(): void {
  // No-op.
}

async function openQuizPanel(
  extensionContext: vscode.ExtensionContext,
  sidebarProvider?: VibeQuizSidebarProvider,
): Promise<void> {
  const stats = getQuizStats(extensionContext.globalState);
  const settings = getAiSettings();
  const storedKey = await getApiKey(extensionContext.secrets, settings.provider);
  const providerNeedsKey = requiresApiKey(settings);
  let modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey);

  try {
    const extraction = await extractQuizContext();
    if (!extraction.ok) {
      renderEmptyPanel(extensionContext, stats, modeStatus, extraction.message);
      return;
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

    const context = extraction.context;
    let questions = generateQuizQuestions(context);
    let sessionUsesAi = settings.mode === 'ai' && (!providerNeedsKey || Boolean(storedKey));
    const sessionApiKey = storedKey ?? '';

    if (sessionUsesAi) {
      try {
        questions = await generateAiQuizQuestions(context, settings, sessionApiKey);
        modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'AI question generation failed.';
        modeStatus = createModeStatus(settings, Boolean(storedKey) || !providerNeedsKey, {
          label: 'AI mode - heuristic fallback',
          detail: `${detail} VibeQuiz fell back to local heuristics for this session.`,
        });
        sessionUsesAi = false;
        void vscode.window.showWarningMessage(
          `${detail} VibeQuiz used local heuristics instead for this session.`,
        );
      }
    }

    const panelState: PanelState = {
      kind: 'quiz',
      title: 'VibeQuiz',
      subtitle: context.changeContext
        ? sessionUsesAi
          ? 'Five diff-aware multiple-choice checks on your latest edits.'
          : 'Five quick multiple-choice checks on your latest edits.'
        : sessionUsesAi
          ? 'AI wrote the questions. Grading stays local and your key never reaches the webview.'
          : 'Five quick multiple-choice checks. No fake intelligence theater.',
      contextTag: context.languageId.toUpperCase(),
      modeStatus,
      quizContext: context,
      questions,
      stats,
    };

    VibeQuizPanel.render(extensionContext, panelState, async ({ answers }) => {
      const reflection = generateReflection(questions, answers);
      const updatedStats = await recordQuiz(extensionContext.globalState, reflection.weakAreas);
      await sidebarProvider?.refresh();

      return {
        feedback: reflection.feedback,
        stats: updatedStats,
        summary: reflection.summary,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error during quiz creation.';
    renderEmptyPanel(extensionContext, stats, modeStatus, `VibeQuiz hit a snag: ${message}`);
  }
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

function updateStatusBarItem(item: vscode.StatusBarItem): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !['file', 'untitled'].includes(editor.document.uri.scheme)) {
    item.hide();
    return;
  }

  const mode = getAiSettings().mode === 'ai' ? 'AI' : 'Local';
  const fileName = editor.document.fileName
    ? editor.document.fileName.split(/[\\/]/).pop() ?? 'current file'
    : 'current file';
  const focusLabel = editor.selection.isEmpty
    ? editor.document.isDirty
      ? 'quiz recent edits'
      : 'quiz this file'
    : 'quiz selection';

  item.text = '$(sparkle) Quiz Me';
  item.tooltip = `VibeQuiz\n${mode} mode\n${focusLabel} in ${fileName}`;
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
