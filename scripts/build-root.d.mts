export type BuildDir = { name: string; absolute: string };
export function resolveBuildDir(value: string | undefined, projectRoot: string): BuildDir;
export function currentBuildDir(projectRoot: string, env?: Record<string, string | undefined>): BuildDir;
export function traceExcludes(distDir: string, projectRoot: string, entries?: string[]): string[];
export function checkStandalone(buildDir: BuildDir): { distDir: string; buildId: string; standalone: string; server: string; staticDir: string };
