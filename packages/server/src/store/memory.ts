/**
 * In-memory ProjectStore — used for tests and as the out-of-the-box default
 * when no persistent backend is configured.
 */
import type { Project, ProjectStore, StoreWarning } from "./interface.js";

export class InMemoryProjectStore implements ProjectStore {
  private projects: Project[] = [];

  /** Seed projects (for test fixtures). */
  seed(projects: Project[]): void {
    this.projects = [...projects];
  }

  async listProjects(): Promise<[Project[], StoreWarning[]]> {
    return [[...this.projects], []];
  }
}
