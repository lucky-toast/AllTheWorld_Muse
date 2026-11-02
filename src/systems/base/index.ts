// The base systems, in load order (spec 9).
import type { SystemDef } from "../../engine/systems";
import type { Host } from "../../engine/host";
import { movement } from "./movement";
import { carry } from "./carry";
import { push } from "./push";
import { daynight } from "./daynight";

export const BASE_SYSTEMS: readonly SystemDef[] = [movement, carry, push, daynight];

/** Load every base system into a host, in order. */
export function loadBaseSystems(host: Host) { for (const def of BASE_SYSTEMS) host.load(def); }
