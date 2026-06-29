import type { KitMeta, KitStore } from "./types.js";

/**
 * In-memory KitStore for unit tests.
 *
 * Seeded with a list of KitMeta entries at construction time.
 * No I/O, no side effects — tests stay fast and deterministic.
 */
export class InMemoryKitStore implements KitStore {
  private readonly kits: Map<string, KitMeta>;

  constructor(seed: KitMeta[] = []) {
    this.kits = new Map(seed.map((k) => [k.id, k]));
  }

  async listKits(): Promise<KitMeta[]> {
    return [...this.kits.values()];
  }

  async getKit(kitId: string): Promise<KitMeta | undefined> {
    return this.kits.get(kitId);
  }
}
