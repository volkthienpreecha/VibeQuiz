import * as vscode from 'vscode';
import { PanelState, SubmitPayload, SubmitResponse } from './types';

type SubmitHandler = (payload: SubmitPayload) => Promise<SubmitResponse>;

export class VibeQuizPanel {
  private static currentPanel: VibeQuizPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private state: PanelState;
  private submitHandler: SubmitHandler;
  private webviewReady = false;
  private readonly disposables: vscode.Disposable[] = [];

  public static render(
    extensionContext: vscode.ExtensionContext,
    state: PanelState,
    onSubmit: SubmitHandler,
  ): void {
    const column = vscode.ViewColumn.Beside;

    if (VibeQuizPanel.currentPanel) {
      VibeQuizPanel.currentPanel.panel.reveal(column);
      VibeQuizPanel.currentPanel.submitHandler = onSubmit;
      VibeQuizPanel.currentPanel.update(state);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeQuiz',
      'VibeQuiz',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, 'media')],
      },
    );

    VibeQuizPanel.currentPanel = new VibeQuizPanel(panel, extensionContext.extensionUri, state, onSubmit);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    state: PanelState,
    onSubmit: SubmitHandler,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.state = state;
    this.submitHandler = onSubmit;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message as { type?: string; payload?: SubmitPayload });
    }, null, this.disposables);
  }

  public dispose(): void {
    VibeQuizPanel.currentPanel = undefined;
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private update(state: PanelState): void {
    this.state = state;
    if (this.webviewReady) {
      void this.postPanelState();
    }
  }

  private async handleMessage(message: { type?: string; payload?: SubmitPayload }): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        await this.postPanelState();
        return;
      case 'submitQuiz': {
        if (!message.payload) {
          return;
        }

        try {
          const response = await this.submitHandler(message.payload);
          this.state = {
            ...this.state,
            feedback: response.feedback,
            stats: response.stats,
            resultSummary: response.summary,
            chunkWeakAreas: response.chunkWeakAreas,
          };
          await this.panel.webview.postMessage({
            type: 'quizFeedback',
            payload: response,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Unexpected error while grading the session.';
          await this.panel.webview.postMessage({
            type: 'submitError',
            payload: { message: detail },
          });
        }
        return;
      }
      case 'skipQuiz':
        this.panel.dispose();
        return;
      default:
        return;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'app.js'));
    const nonce = getNonce();
    const stateJson = JSON.stringify(this.state).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>VibeQuiz</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">window.__VIBEQUIZ_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private async postPanelState(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'panelState',
      payload: this.state,
    });
  }
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}
