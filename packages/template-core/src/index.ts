import { cp } from "node:fs/promises";
import path from "node:path";

const skippedTemplateSegments = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules"
]);

const skippedTemplateFiles = new Set([".DS_Store", "Thumbs.db"]);

export async function copyCapsuleTemplate(sourcePath: string, targetPath: string): Promise<void> {
  const sourceRoot = path.resolve(sourcePath);

  await cp(sourceRoot, targetPath, {
    errorOnExist: true,
    filter(source) {
      const relativePath = path.relative(sourceRoot, path.resolve(source));
      if (!relativePath) {
        return true;
      }

      const segments = relativePath.split(path.sep);
      return (
        !segments.some((segment) => skippedTemplateSegments.has(segment)) &&
        !skippedTemplateFiles.has(segments.at(-1) ?? "")
      );
    },
    recursive: true
  });
}
