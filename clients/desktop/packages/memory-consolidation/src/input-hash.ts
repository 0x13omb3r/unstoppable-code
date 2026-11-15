import type { MemoryImportSourceTool } from './input-budget';

/*
 * What a consolidation run's `inputHash` covers, in order. Every holder
 * (desktop and Canopy Cloud) feeds these parts, in order, to SHA-256, so the
 * same input hashes the same everywhere and revisions can be compared across
 * holders (cloud memory sync design §12.3). Hashing the concatenation gives
 * the same digest as feeding the parts one by one.
 */

export interface MemoryConsolidationHashFile {
  fileKey: string;
  content: string;
}

export interface MemoryConsolidationHashImport {
  fileKey: string;
  fileHash: string;
  sourceTool?: MemoryImportSourceTool;
  repo?: string;
  modified?: string;
}

export function memoryConsolidationInputHashParts(input: {
  memoryMd: string;
  files: readonly MemoryConsolidationHashFile[];
  imports: readonly MemoryConsolidationHashImport[];
  /** Ordered retry pairs are prompt input even after their markup is gone. */
  unresolvedLinks?: readonly { source: string; target: string }[];
}): string[] {
  const parts = ['MEMORY.md\0', input.memoryMd];
  const byKey = (
    left: { fileKey: string },
    right: { fileKey: string },
  ): number => left.fileKey.localeCompare(right.fileKey);
  for (const file of [...input.files].sort(byKey)) {
    parts.push('\0', file.fileKey, '\0', file.content);
  }
  for (const material of [...input.imports].sort(byKey)) {
    parts.push(
      '\0import-ledger\0',
      material.fileKey,
      '\0',
      material.fileHash,
      '\0',
    );
    if (material.sourceTool) parts.push(material.sourceTool, '\0');
    parts.push(material.repo ?? '', '\0', material.modified ?? '');
  }
  // Keep historical digests unchanged when no durable retry work is present.
  if (input.unresolvedLinks && input.unresolvedLinks.length > 0) {
    parts.push(
      '\0link-retries\0',
      JSON.stringify(
        input.unresolvedLinks.map(({ source, target }) => [source, target]),
      ),
    );
  }
  return parts;
}
