export const PUBLIC_MARKDOWN_FILES: readonly string[];

export interface ForbiddenMatch {
  readonly path: string;
  readonly pattern: string;
}

export function unexpectedMarkdownFiles(markdownFiles: readonly string[]): string[];
export function forbiddenMatches(path: string, content: string): ForbiddenMatch[];
export function forbiddenArtifactPath(path: string): boolean;
export function verifyPublicDocs(root?: string): Promise<void>;
