import * as vscode from 'vscode';
import { QuizStats } from './types';

const STORAGE_KEY = 'vibeQuiz.stats';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function getQuizStats(globalState: vscode.Memento): QuizStats {
  return (
    globalState.get<QuizStats>(STORAGE_KEY) ?? {
      quizzesTaken: 0,
      streak: 0,
      recentWeakAreas: [],
    }
  );
}

export async function recordQuiz(
  globalState: vscode.Memento,
  weakAreas: string[],
): Promise<QuizStats> {
  const current = getQuizStats(globalState);
  const now = new Date();
  const nextStats: QuizStats = {
    quizzesTaken: current.quizzesTaken + 1,
    lastQuizAt: now.toISOString(),
    streak: calculateStreak(current, now),
    recentWeakAreas: mergeWeakAreas(current.recentWeakAreas, weakAreas),
  };

  await globalState.update(STORAGE_KEY, nextStats);
  return nextStats;
}

function calculateStreak(current: QuizStats, now: Date): number {
  if (!current.lastQuizAt) {
    return 1;
  }

  const lastDate = new Date(current.lastQuizAt);
  const diff = daysBetween(startOfDay(lastDate), startOfDay(now));

  if (diff === 0) {
    return Math.max(current.streak, 1);
  }

  if (diff === 1) {
    return Math.max(current.streak, 0) + 1;
  }

  return 1;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function daysBetween(left: Date, right: Date): number {
  return Math.round((right.getTime() - left.getTime()) / ONE_DAY_MS);
}

function mergeWeakAreas(current: string[], incoming: string[]): string[] {
  return Array.from(new Set([...incoming, ...current])).slice(0, 5);
}
