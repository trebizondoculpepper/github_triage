/**
 * Language policy enforcement (doc/design/typescript.md, #112, #113).
 *
 * First-party code under the scoped directories is TypeScript. A non-TypeScript file is
 * acceptable only when it is listed here with its justification, and nothing in `src/`
 * (including tests) or `scripts/` imports it.
 */

/** Directories the language boundary covers, relative to the repository root. */
export const LANGUAGE_SCOPE: readonly string[] = ["src/", "scripts/", "doc/reports/examples/"];

/** Extensions that need an explicit allowlist entry inside the scope. */
export const RESTRICTED_EXTENSION = /\.(?:[cm]?js|sh|bat|cmd|ps1|py)$/i;

/** One deliberately non-TypeScript file and why it is allowed. */
export interface LanguageException {
  /** Exact repository-relative path, using forward slashes. */
  readonly file: string;
  readonly purpose: string;
  /** How it is invoked and what it may touch; nothing in TypeScript may import it. */
  readonly integrationBoundary: string;
  readonly runtimeRequirements: string;
  readonly supportedPlatforms: string;
  /** How the file is checked or exercised. */
  readonly validation: string;
}

/** The single checked-in allowlist. Every current helper is TypeScript, so it is empty. */
export const LANGUAGE_EXCEPTIONS: readonly LanguageException[] = [];

/** Report policy violations for the given scoped files and TypeScript sources. */
export function languageViolations(
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
  exceptions: readonly LanguageException[] = LANGUAGE_EXCEPTIONS,
): string[] {
  const listed = new Set(exceptions.map((entry) => entry.file));
  const present = new Set(files);
  const violations: string[] = [];
  for (const file of files) {
    if (RESTRICTED_EXTENSION.test(file) && !listed.has(file)) {
      violations.push(`${file}: non-TypeScript file is not on the allowlist`);
    }
  }
  for (const entry of exceptions) {
    if (!present.has(entry.file)) violations.push(`${entry.file}: allowlisted file does not exist`);
  }
  const specifier =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (const [source, text] of sources) {
    for (const match of text.matchAll(specifier)) {
      const target = resolveSpecifier(source, match[1]!);
      if (target !== undefined && listed.has(target)) {
        violations.push(`${source}: imports allowlisted non-TypeScript file ${target}`);
      }
    }
  }
  return violations;
}

/** Resolve a relative import specifier against its importing file; bare specifiers are ignored. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}
