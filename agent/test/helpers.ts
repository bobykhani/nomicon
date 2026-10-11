import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLaws, type Laws } from "../src/laws.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const rawLaws = readFileSync(resolve(repoRoot, "laws.json"), "utf8");
export const rawSchema = readFileSync(resolve(repoRoot, "laws.schema.json"), "utf8");
export const loaded = parseLaws(rawLaws, rawSchema);
export const laws: Laws = loaded.laws;

export function withLaws(mutate: (l: Laws) => void): string {
  const copy = JSON.parse(rawLaws) as Laws;
  mutate(copy);
  return JSON.stringify(copy);
}

export const DAY = 86400;
