// ABI names shared by the compiler and the loader. Kept apart from compile.ts so the game's
// main bundle doesn't pull in the AssemblyScript compiler (only the pipeline worker needs it).

/** The glue exports the host relies on (spec 10.2; see src/sdk/README.md). */
export const GLUE_EXPORTS = ["__atw_alloc", "__atw_string", "__atw_unpin", "__atw_abort_message", "__atw_abort_file", "__atw_abort_line", "__atw_abort_column"] as const;
/** The exported start function. The host calls it under fuel right after instantiating. */
export const START_EXPORT = "__atw_start";
/** Optional glue export (modules built before it lack it): collect garbage between calls. */
export const COLLECT_EXPORT = "__atw_collect";
/** Optional glue export: forget reads the SDK remembered, called as every call into the module begins. */
export const FORGET_EXPORT = "__atw_forget";
