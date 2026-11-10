// Skills (docs/design/v4-plan.md §11.2 item 8, §8.3): when a goal with a success condition is
// reached, the methods that made progress on the way are kept as "how I got X", and the next
// goal for X shows them to her. Kept by the director for as long as the module runs and
// published on `SKILL_TOPIC` for a store that keeps them across restarts (§8.3, not built yet).
// Pure apart from the clock values passed in.

/** Topic of a learned skill, `Skill`. */
export const SKILL_TOPIC = "game.director.skill";

export interface Skill {
  game: string;
  /** The item the goal wanted. */
  target: string;
  /** The goal as she put it. */
  goal: string;
  /** The methods that made progress, in order (`obtain {"item":"cooked_beef"}`). */
  steps: string[];
  at: number;
}

/** Kept per target (newest first) and in all. */
const PER_TARGET = 3;
const MAX_SKILLS = 40;

export class SkillBook {
  readonly #skills: Skill[] = [];

  /** Keeps a skill (an identical one moves to the front). Returns it, or `null` without steps. */
  learn(skill: Skill): Skill | null {
    if (skill.steps.length === 0) return null;
    const same = (s: Skill) =>
      s.game === skill.game &&
      s.target === skill.target &&
      s.steps.join("\n") === skill.steps.join("\n");
    const i = this.#skills.findIndex(same);
    if (i >= 0) this.#skills.splice(i, 1);
    this.#skills.unshift(skill);
    const forTarget = this.#skills.filter(
      (s) => s.game === skill.game && s.target === skill.target,
    );
    for (const old of forTarget.slice(PER_TARGET))
      this.#skills.splice(this.#skills.indexOf(old), 1);
    this.#skills.splice(MAX_SKILLS);
    return skill;
  }

  forTarget(game: string, target: string): Skill[] {
    return this.#skills.filter((s) => s.game === game && s.target === target);
  }

  /**
   * Prompt lines: the ways she got `target` before, or (no target) the things she has managed
   * at all, newest first.
   */
  lines(game: string, target: string | null, max = 5): string[] {
    if (target !== null) {
      return this.forTarget(game, target).map((s) => `之前拿到 ${s.target}:${s.steps.join(" → ")}`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of this.#skills) {
      if (s.game !== game || seen.has(s.target)) continue;
      seen.add(s.target);
      out.push(`${s.target}:${s.steps.join(" → ")}`);
      if (out.length >= max) break;
    }
    return out;
  }
}
