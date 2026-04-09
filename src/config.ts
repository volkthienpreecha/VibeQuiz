import * as vscode from 'vscode';
import { AiProvider, ModeStatus, QuizMode } from './types';

export interface AiSettings {
  mode: QuizMode;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  anthropicVersion: string;
}

const CONFIG_ROOT = 'vibeQuiz';

export function getAiSettings(): AiSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_ROOT);
  const mode = config.get<QuizMode>('mode', 'heuristic');
  const provider = config.get<AiProvider>('ai.provider', 'openai');
  const rawModel = config.get<string>('ai.model', '').trim();
  const rawBaseUrl = config.get<string>('ai.baseUrl', '').trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(3000, config.get<number>('ai.timeoutMs', 20000));
  const anthropicVersion = config.get<string>('ai.anthropicVersion', '2023-06-01').trim() || '2023-06-01';
  const model = rawModel || getDefaultModel(provider);
  const baseUrl = rawBaseUrl || getDefaultBaseUrl(provider);

  return {
    mode,
    provider,
    model,
    baseUrl,
    timeoutMs,
    anthropicVersion,
  };
}

export async function setQuizMode(mode: QuizMode): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_ROOT)
    .update('mode', mode, vscode.ConfigurationTarget.Global);
}

export async function setAiProvider(provider: AiProvider): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_ROOT)
    .update('ai.provider', provider, vscode.ConfigurationTarget.Global);
}

export async function setAiModel(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_ROOT)
    .update('ai.model', model.trim(), vscode.ConfigurationTarget.Global);
}

export async function setAiBaseUrl(baseUrl: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_ROOT)
    .update('ai.baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
}

export function getDefaultModel(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-20250514';
    case 'gemini':
      return 'gemini-2.5-flash';
    case 'openaiCompatible':
      return 'qwen3:8b';
    case 'openai':
    default:
      return 'gpt-5-mini';
  }
}

export function getDefaultBaseUrl(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'openaiCompatible':
      return 'http://localhost:11434/v1';
    case 'openai':
    default:
      return 'https://api.openai.com/v1';
  }
}

export function requiresApiKey(settings: AiSettings): boolean {
  if (settings.provider === 'openaiCompatible' && isLocalBaseUrl(settings.baseUrl)) {
    return false;
  }

  return true;
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

export function createModeStatus(
  settings: AiSettings,
  keyConfigured: boolean,
  override?: Partial<Pick<ModeStatus, 'label' | 'detail'>>,
): ModeStatus {
  const providerNeedsKey = requiresApiKey(settings);

  if (settings.mode === 'ai') {
    return {
      mode: 'ai',
      label: override?.label ?? `AI mode - ${providerLabel(settings.provider)}`,
      detail:
        override?.detail ??
        (providerNeedsKey && keyConfigured
          ? `BYOK is enabled. Requests run in the extension host with ${settings.model}, and your key stays in VS Code Secret Storage.`
          : providerNeedsKey
            ? 'AI mode is enabled, but no API key is stored yet. Use "VibeQuiz: Set API Key" to finish setup.'
            : `AI mode is enabled against ${settings.baseUrl} using ${settings.model}. This looks like a local or keyless OpenAI-compatible endpoint.`),
      provider: settings.provider,
      model: settings.model,
      keyConfigured: keyConfigured || !providerNeedsKey,
    };
  }

  return {
    mode: 'heuristic',
    label: override?.label ?? 'Heuristic mode',
    detail:
      override?.detail ??
      'Questions and reflection are generated locally. No API key and no outbound model call are required.',
    provider: settings.provider,
    model: settings.model,
    keyConfigured,
  };
}

export function providerLabel(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic Claude';
    case 'gemini':
      return 'Google Gemini';
    case 'openaiCompatible':
      return 'OpenAI-compatible';
    case 'openai':
    default:
      return 'OpenAI';
  }
}
