import * as vscode from 'vscode';
import { providerLabel, setQuizMode } from './config';
import { AiProvider } from './types';

const SECRET_KEYS: Record<AiProvider, string> = {
  openai: 'vibeQuiz.openai.apiKey',
  anthropic: 'vibeQuiz.anthropic.apiKey',
  gemini: 'vibeQuiz.gemini.apiKey',
  openaiCompatible: 'vibeQuiz.openaiCompatible.apiKey',
};

export async function getApiKey(
  secrets: vscode.SecretStorage,
  provider: AiProvider,
): Promise<string | undefined> {
  const stored = await secrets.get(SECRET_KEYS[provider]);
  const trimmed = stored?.trim();
  return trimmed ? trimmed : undefined;
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  provider: AiProvider,
): Promise<boolean> {
  return Boolean(await getApiKey(secrets, provider));
}

export async function promptAndStoreApiKey(
  secrets: vscode.SecretStorage,
  provider: AiProvider,
): Promise<boolean> {
  const label = providerLabel(provider);
  const value = await vscode.window.showInputBox({
    title: `VibeQuiz - Set ${label} API Key`,
    prompt: `${label} API key`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Paste your API key. It will be stored in VS Code Secret Storage.',
    validateInput: (input) => {
      if (!input.trim()) {
        return 'API key cannot be empty.';
      }

      if (input.trim().length < 12) {
        return 'That key looks too short to be valid.';
      }

      return undefined;
    },
  });

  if (value === undefined) {
    return false;
  }

  await secrets.store(SECRET_KEYS[provider], value.trim());

  const action = await vscode.window.showInformationMessage(
    `${label} API key saved securely in VS Code Secret Storage.`,
    'Enable AI Mode',
    'Open Settings',
  );

  if (action === 'Enable AI Mode') {
    await setQuizMode('ai');
  }

  if (action === 'Open Settings') {
    await vscode.commands.executeCommand('vibeQuiz.openSettings');
  }

  return true;
}

export async function clearApiKey(
  secrets: vscode.SecretStorage,
  provider: AiProvider,
): Promise<boolean> {
  const label = providerLabel(provider);
  const existing = await secrets.get(SECRET_KEYS[provider]);

  if (!existing) {
    void vscode.window.showInformationMessage(`No stored ${label} API key was found.`);
    return false;
  }

  await secrets.delete(SECRET_KEYS[provider]);
  void vscode.window.showInformationMessage(`${label} API key removed from VS Code Secret Storage.`);
  return true;
}
