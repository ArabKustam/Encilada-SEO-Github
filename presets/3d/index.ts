import { createPresetComposition } from "./_engine/engine.js";
import type { SceneComponent } from "./_engine/types.js";
import { Scene as BrowserTilt } from "./browser-tilt/Scene.js";
import { Scene as LaptopOrbit } from "./laptop-orbit/Scene.js";
import { Scene as PhoneFloat } from "./phone-float/Scene.js";

/** Every preset folder must be registered here under the `name` from its preset.json. */
const SCENES: Record<string, SceneComponent> = {
  "browser-tilt": BrowserTilt,
  "laptop-orbit": LaptopOrbit,
  "phone-float": PhoneFloat,
};

export const REGISTERED_PRESETS = Object.keys(SCENES);
export const Preset3D = createPresetComposition(SCENES);
export { PRESET_COMPOSITION_ID } from "./_engine/types.js";
export { Stage3D } from "./_engine/stage.js";
export { STAGE_COMPOSITION_ID } from "./_engine/stage-types.js";
