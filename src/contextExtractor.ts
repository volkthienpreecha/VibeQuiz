import * as path from 'path';
import * as vscode from 'vscode';
import { ExtractionResult, QuizContext } from './types';

interface FlatSymbol {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

const MAX_SNIPPET_LINES = 14;
const MAX_SNIPPET_LENGTH = 900;

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

  const selectionText = editor.selection.isEmpty
    ? undefined
    : document.getText(editor.selection).trim();

  const symbols = await loadSymbols(document.uri);
  const focusSymbol = findFocusSymbol(symbols, editor.selection.active);
  const focusSnippet = buildFocusSnippet(document, editor.selection, focusSymbol);
  const fileName = document.fileName
    ? path.basename(document.fileName)
    : document.uri.path.split('/').pop() ?? 'Untitled';

  const focusKind: QuizContext['focusKind'] = selectionText
    ? 'selection'
    : focusSymbol
      ? 'symbol'
      : 'file';

  const symbolName = focusSymbol?.name;
  const focusLabel = selectionText
    ? symbolName
      ? `${symbolName} selection`
      : 'Selected code'
    : symbolName ?? fileName;

  const analysisText = [selectionText, focusSnippet, fullText].filter(Boolean).join('\n');
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
    },
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
): string {
  if (!selection.isEmpty) {
    return sanitizeSnippet(document.getText(selection));
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

function formatSelection(selection: vscode.Selection): string {
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
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
