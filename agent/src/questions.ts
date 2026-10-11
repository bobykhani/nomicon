/**
 * Law 12: the optional header a World file may carry, and the index of open
 * questions derived from merged contributions.
 *
 *   ---
 *   nomicon:
 *     question: "one line"
 *     answers: [world/path/of/question.md]
 *     cites: [world/path/of/entry.md]
 *   ---
 */
import { parse as parseYaml } from "yaml";

export interface Header { question?: string; answers: string[]; cites: string[] }

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parse the header of a Markdown file. Malformed headers are ignored, never fatal. */
export function parseHeader(content: string): Header | null {
  const m = FRONT.exec(content);
  if (!m) return null;
  let doc: unknown;
  try { doc = parseYaml(m[1]!); } catch { return null; }
  if (!doc || typeof doc !== "object") return null;
  const n = (doc as Record<string, unknown>)["nomicon"];
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 512) : []);
  const h: Header = { answers: strs(o["answers"]), cites: strs(o["cites"]) };
  if (typeof o["question"] === "string" && o["question"].trim()) h.question = o["question"].trim().slice(0, 500);
  return h;
}

export interface Question {
  id: string;            // path of the file that asked it
  question: string;
  asked_by: number;
  asked_login: string;
  asked_at: number;
  pr: number;
  answers: Array<{ path: string; by: number; login: string; merged_at: number; pr: number }>;
}

export interface QuestionsIndex { version: 1; computed_at: number; open: Question[]; answered: Question[] }

export function buildIndex(questions: Record<string, Question>, now: number): QuestionsIndex {
  const all = Object.values(questions).sort((a, b) => a.asked_at - b.asked_at);
  return { version: 1, computed_at: now, open: all.filter((q) => q.answers.length === 0), answered: all.filter((q) => q.answers.length > 0) };
}
