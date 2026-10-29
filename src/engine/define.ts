// defineSystem: fills defaults so systems only write what they need.
import type { SystemDef } from './api';

export type SystemInput = Partial<SystemDef> & { id: string };

/** Builds a system module, filling buildsOn/contract/components/entities/on/tests/shots. */
export function defineSystem(input: SystemInput): SystemDef {
  if (!input || typeof (input as { id?: unknown }).id !== 'string' || input.id === '') {
    throw new Error('defineSystem needs a string "id"');
  }
  return {
    id: input.id,
    why: input.why ?? '',
    buildsOn: input.buildsOn ?? [],
    contract: {
      claims: input.contract?.claims ?? [],
      emits: input.contract?.emits ?? {},
      hooks: input.contract?.hooks ?? [],
    },
    components: input.components ?? {},
    entities: input.entities ?? {},
    migrate: input.migrate,
    onTick: input.onTick,
    on: input.on ?? {},
    tests: input.tests ?? [],
    shots: input.shots ?? [],
  };
}
