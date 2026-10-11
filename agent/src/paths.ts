import { layerOfPath, strictest, type Layer } from "./constitution.js";
import type { Laws } from "./laws.js";

/** One changed path as the agent sees it in a pull request diff. */
export interface ChangedFile {
  /** Path after the change (or before, for deletions). Forward slashes. */
  path: string;
  /** For renames, the path before. */
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Git mode after the change, e.g. "100644", "120000" (symlink), "160000" (submodule). */
  mode?: string;
  /** Bytes added plus bytes modified in the diff for this file. */
  bytesChanged: number;
  /** Size of the file after the change, in bytes (0 for removals). */
  sizeAfter: number;
}

export interface PathProblem { path: string; reason: string }

/** Law 6 path rules. `existing` is the set of paths at the base commit. */
export function pathProblems(files: ChangedFile[], existing: Iterable<string>, laws: Laws): PathProblem[] {
  const re = new RegExp(laws.submission.path_charset);
  const out: PathProblem[] = [];
  const lowerExisting = new Map<string, string>();
  for (const e of existing) lowerExisting.set(e.normalize("NFC").toLowerCase(), e);
  const seen = new Map<string, string>();
  for (const f of files) {
    for (const p of [f.path, f.previousPath].filter((x): x is string => !!x)) {
      if (p.normalize("NFC") !== p) out.push({ path: p, reason: "path is not NFC-normalized" });
      if (!re.test(p)) out.push({ path: p, reason: "path contains characters outside the allowed set" });
      const parts = p.split("/");
      if (parts.some((c) => c === "" || c === "." || c === "..")) out.push({ path: p, reason: "path has an empty, '.' or '..' component" });
    }
    if (f.status === "removed") continue;
    const key = f.path.normalize("NFC").toLowerCase();
    const clash = lowerExisting.get(key);
    if (clash !== undefined && clash !== f.path) out.push({ path: f.path, reason: `collides with existing path ${clash} ignoring case` });
    const dup = seen.get(key);
    if (dup !== undefined && dup !== f.path) out.push({ path: f.path, reason: `collides with ${dup} in the same change ignoring case` });
    seen.set(key, f.path);
  }
  return out;
}

/** Article 2: the layer of a whole change is the strictest layer of any path it touches, both sides of renames. */
export function layerOfChange(files: ChangedFile[]): { layer: Layer; perPath: Array<{ path: string; layer: Layer }> } {
  const perPath: Array<{ path: string; layer: Layer }> = [];
  for (const f of files) {
    perPath.push({ path: f.path, layer: layerOfPath(f.path) });
    if (f.previousPath) perPath.push({ path: f.previousPath, layer: layerOfPath(f.previousPath) });
  }
  return { layer: strictest(perPath.map((p) => p.layer)), perPath };
}
