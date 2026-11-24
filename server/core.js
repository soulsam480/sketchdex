import { buildElements as buildElementsJs } from "./elements.js";
import { buildElements as buildElementsNim, closeCore as closeNimCore } from "./core-worker.js";

export { CoreError } from "./core-worker.js";

// Read once at module load; the default stays JavaScript.
export const CORE_BACKEND = process.env.SKETCHDEX_CORE === "nim" ? "nim" : "js";

export async function buildElements(specs, options = {}) {
  if (CORE_BACKEND === "js") return buildElementsJs(specs, options);
  return buildElementsNim(specs, options);
}

export async function closeCore() {
  return closeNimCore();
}
