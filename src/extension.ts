import * as vscode from 'vscode';
import { extractQuizContext } from './contextExtractor';
import { generateReflection } from './feedback';
import { VibeQuizPanel } from './panel';
import { generateQuizQuestions } from './quizGenerator';
import { getQuizStats, recordQuiz } from './storage';
import { PanelState } from './types';

export function activate(extensionContext: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('vibeQuiz.quizMe', async () => {
    const stats = getQuizStats(extensionContext.globalState);

    try {
      const extraction = await extractQuizContext();

      if (!extraction.ok) {
        VibeQuizPanel.render(
          extensionContext,
          {
            kind: 'empty',
            title: 'VibeQuiz',
            subtitle: 'Quick recall for the code you just wrote.',
            emptyMessage: extraction.message,
            stats,
          },
          async () => ({ feedback: [], stats }),
        );
        return;
      }

      const questions = generateQuizQuestions(extraction.context);
      const panelState: PanelState = {
        kind: 'quiz',
        title: 'VibeQuiz',
        subtitle: 'Three sharp questions. No fake intelligence theater.',
        contextTag: extraction.context.languageId.toUpperCase(),
        quizContext: extraction.context,
        questions,
        stats,
      };

      VibeQuizPanel.render(extensionContext, panelState, async ({ answers }) => {
        const reflection = generateReflection(questions, answers);
        const updatedStats = await recordQuiz(extensionContext.globalState, reflection.weakAreas);

        return {
          feedback: reflection.feedback,
          stats: updatedStats,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error during quiz creation.';
      VibeQuizPanel.render(
        extensionContext,
        {
          kind: 'empty',
          title: 'VibeQuiz',
          subtitle: 'Quick recall for the code you just wrote.',
          emptyMessage: `VibeQuiz hit a snag: ${message}`,
          stats,
        },
        async () => ({ feedback: [], stats }),
      );
    }
  });

  extensionContext.subscriptions.push(command);
}

export function deactivate(): void {
  // No-op.
}
