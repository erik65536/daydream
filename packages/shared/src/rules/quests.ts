/** Quests as the game plays them: the fixed vocabulary of objectives, a quest's steps and their ways, and progress. */

const OBJECTIVE_TYPES = ['talk', 'kill', 'kill_unique', 'collect', 'deliver', 'persuade'] as const;
type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

export interface QuestObjective {
  id: string;
  type: ObjectiveType;
  description: string;
  /** talk / deliver / persuade target. */
  npcId?: string;
  /** kill: monster family (any member), optionally limited to a zone. */
  familyId?: string;
  /** kill_unique: the boss or named foe (boss id); defeated before the step comes, it counts when it does. */
  targetId?: string;
  /** collect / deliver: the unique (world-defined) item. */
  itemUniqueId?: string;
  /** Where it is done: the place of a fight, a foe, or a thing to find. */
  zoneId?: string;
  count?: number;
  /** Hidden until all previous objectives are complete. */
  hidden?: boolean;
  /**
   * The step it belongs to and which of the step's ways (fight them, or talk them round): a step is done when every
   * objective of one of its ways is. Without them, an objective is a step of its own.
   */
  step?: number;
  way?: number;
  /**
   * persuade: what they come to agree to, when the description does not say it: a clever way around a fight is shown
   * only as someone to see, and the plan comes out in talking with them.
   */
  agree?: string;
}

interface QuestReward {
  xp: number;
  gold: number;
  /** Unique item ids or base item ids (base items are rolled at quest level). */
  items: string[];
}

export interface QuestDef {
  id: string;
  title: string;
  summary: string;
  main: boolean;
  arcIndex?: number;
  level: number;
  /** Who asks for it, and whom every quest ends by going back to. */
  giverNpcId?: string;
  zoneId?: string;
  objectives: QuestObjective[];
  rewards: QuestReward;
  prerequisites: string[];
  /** Started automatically when prerequisites complete (e.g. the opening main quest). */
  autoStart?: boolean;
}

type QuestStatus = 'active' | 'completed' | 'failed';

interface ObjectiveProgress {
  progress: number;
  done: boolean;
}

export interface QuestProgress {
  questId: string;
  status: QuestStatus;
  objectives: Record<string, ObjectiveProgress>;
  /** Short log lines, newest last. */
  log: { day: number; text: string }[];
  startedDay: number;
}

/** A step of a quest: the ways it can be done, each objectives done in order. Doing every objective of one way does it. */
type QuestStep = QuestObjective[][];

/** A quest's steps in order. */
export function questSteps(def: QuestDef): QuestStep[] {
  const steps: QuestStep[] = [];
  let at: number | undefined;
  for (const o of def.objectives) {
    if (o.step === undefined || o.step !== at) steps.push([]);
    at = o.step;
    const ways = steps.at(-1)!;
    (ways[o.way ?? 0] ??= []).push(o);
  }
  return steps.map((ways) => ways.filter(Boolean));
}

const stepDone = (ways: QuestStep, prog: QuestProgress | undefined) => ways.some((w) => w.every((o) => prog?.objectives[o.id]?.done));

/** What the heroes can do now: the next objective of each way of the first step not done. None when every step is done. */
export function currentWays(def: QuestDef, prog: QuestProgress | undefined): QuestObjective[] {
  const step = questSteps(def).find((ways) => !stepDone(ways, prog));
  return step ? step.map((w) => w.find((o) => !prog?.objectives[o.id]?.done)!) : [];
}

/** Each way of the first step not done, with all it still takes in order (find the thing, then bring it to someone). */
export function currentPlans(def: QuestDef, prog: QuestProgress | undefined): QuestObjective[][] {
  const step = questSteps(def).find((ways) => !stepDone(ways, prog));
  return step ? step.map((w) => w.filter((o) => !prog?.objectives[o.id]?.done)) : [];
}

/** Whether the quest is on its last step. */
export function onLastStep(def: QuestDef, prog: QuestProgress | undefined): boolean {
  const steps = questSteps(def);
  return steps.findIndex((ways) => !stepDone(ways, prog)) === steps.length - 1;
}

/** Whether an objective was left undone because another way did its step. */
export function passedBy(def: QuestDef, prog: QuestProgress | undefined, o: QuestObjective): boolean {
  if (prog?.objectives[o.id]?.done) return false;
  const ways = questSteps(def).find((w) => w.some((x) => x.includes(o)));
  return !!ways && stepDone(ways, prog);
}
