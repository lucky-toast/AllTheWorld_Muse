import movement from "./movement";
import carry from "./carry";
import push from "./push";
import use from "./use";
import daynight from "./daynight";
import type { SystemDef } from "../../engine/api";
export const BASE_SYSTEMS: SystemDef[] = [movement, carry, push, use, daynight];
export { movement, carry, push, use, daynight };
