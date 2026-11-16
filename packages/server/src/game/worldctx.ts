/** Read-only helpers over a WorldDefinition (places' ground, lookups, naming). */
import {
  Nav, itemDisplayName, rx, type BossDef, type FeatureDef, type ItemInstance, type MonsterFamily, type MonsterMember, type NpcDef, type QuestDef,
  type Ruleset, type UniqueItemDef, type WorldDefinition, type ZoneDef,
} from '@daydream/shared';

/** A place as the game uses it: where people can walk and see, and its features by id. */
export interface ZoneMap {
  def: ZoneDef;
  nav: Nav;
  features: Map<string, FeatureDef>;
}

export class WorldCtx {
  readonly zones = new Map<string, ZoneDef>();
  readonly npcs = new Map<string, NpcDef>();
  readonly families = new Map<string, MonsterFamily>();
  readonly bosses = new Map<string, BossDef>();
  readonly quests = new Map<string, QuestDef>();
  /** The quests sent to defeat each boss or named foe (by boss id): it waits unseen until one of them has begun. */
  readonly foeQuests = new Map<string, string[]>();
  private maps = new Map<string, ZoneMap>();
  readonly r: Ruleset;
  /** World uniques plus items created during play. */
  uniqueItems: Record<string, UniqueItemDef>;
  readonly world: WorldDefinition;

  constructor(world: WorldDefinition) {
    this.world = world;
    for (const z of world.zones) this.zones.set(z.id, z);
    for (const n of world.npcs) this.npcs.set(n.id, n);
    for (const f of world.families) this.families.set(f.id, f);
    for (const b of world.bosses) this.bosses.set(b.id, b);
    for (const q of world.quests) {
      this.quests.set(q.id, q);
      for (const o of q.objectives) if (o.type === 'kill_unique' && o.targetId) this.foeQuests.set(o.targetId, [...(this.foeQuests.get(o.targetId) ?? []), q.id]);
    }
    this.r = world.ruleset;
    this.uniqueItems = { ...world.uniqueItems };
  }

  itemName(item: ItemInstance): string {
    return itemDisplayName(this.r, item, { uniqueItems: this.uniqueItems });
  }

  itemDescription(item: ItemInstance): string {
    if (item.uniqueId && this.uniqueItems[item.uniqueId]) return this.uniqueItems[item.uniqueId]!.description;
    return rx(this.r).item.get(item.baseId)?.description ?? '';
  }

  skillName(skillId: string): string {
    return rx(this.r).skill.get(skillId)?.name ?? skillId;
  }

  className(classId: string): string {
    return rx(this.r).cls.get(classId)?.name ?? classId;
  }

  map(zoneId: string): ZoneMap {
    let m = this.maps.get(zoneId);
    if (m) return m;
    const def = this.zones.get(zoneId);
    if (!def) throw new Error(`Unknown zone ${zoneId}`);
    if (!def.nav) throw new Error(`${def.name} has not been painted`);
    m = { def, nav: new Nav(def.nav), features: new Map(def.features.map((f) => [f.id, f])) };
    this.maps.set(zoneId, m);
    return m;
  }

  family(id: string): MonsterFamily | undefined {
    return this.families.get(id);
  }

  member(familyId: string, index: number): MonsterMember | undefined {
    const f = this.families.get(familyId);
    return f?.members[index] ?? f?.members[0];
  }

  /** The town a place is (undefined for wild places and dungeons). */
  townOf(zoneId: string): string | undefined {
    return this.zones.get(zoneId)?.kind === 'town' ? zoneId : undefined;
  }
}
