// export_roblox: Figma font families → Roblox font families (rbxasset://fonts/families/*.json).
// Roblox only ships its own set of fonts, so close matches stand in for the rest.

export const ROBLOX_FONTS: Record<string, string> = {
  // Built-in families with the same name.
  "builder sans": "BuilderSans",
  montserrat: "Montserrat",
  roboto: "Roboto",
  "roboto condensed": "RobotoCondensed",
  "roboto mono": "RobotoMono",
  "source sans pro": "SourceSansPro",
  "source sans 3": "SourceSansPro",
  nunito: "Nunito",
  oswald: "Oswald",
  merriweather: "Merriweather",
  ubuntu: "Ubuntu",
  "titillium web": "TitilliumWeb",
  "press start 2p": "PressStart2P",
  "fredoka one": "FredokaOne",
  fredoka: "FredokaOne",
  bangers: "Bangers",
  creepster: "Creepster",
  "luckiest guy": "LuckiestGuy",
  "permanent marker": "PermanentMarker",
  "patrick hand": "PatrickHand",
  "indie flower": "IndieFlower",
  "amatic sc": "AmaticSC",
  kalam: "Kalam",
  michroma: "Michroma",
  jura: "Jura",
  sarpanch: "Sarpanch",
  "special elite": "SpecialElite",
  "denk one": "DenkOne",
  inconsolata: "Inconsolata",
  arimo: "Arimo",
  gotham: "GothamSSm",
  "gotham ssm": "GothamSSm",
  // Close matches.
  inter: "BuilderSans",
  "sf pro": "BuilderSans",
  "sf pro text": "BuilderSans",
  "sf pro display": "BuilderSans",
  "open sans": "BuilderSans",
  lato: "BuilderSans",
  poppins: "Montserrat",
  "dm sans": "BuilderSans",
  manrope: "BuilderSans",
  "plus jakarta sans": "BuilderSans",
  "work sans": "BuilderSans",
  "ibm plex sans": "SourceSansPro",
  arial: "Arimo",
  helvetica: "Arimo",
  "helvetica neue": "Arimo",
  "segoe ui": "BuilderSans",
  "jetbrains mono": "RobotoMono",
  "fira code": "RobotoMono",
  "source code pro": "RobotoMono",
  "sf mono": "RobotoMono",
  "courier new": "RobotoMono",
  georgia: "Merriweather",
  "times new roman": "Merriweather",
  "playfair display": "Merriweather",
  "bebas neue": "Oswald",
  anton: "Oswald",
  "comic sans ms": "PatrickHand",
};

export const DEFAULT_FONT = "BuilderSans";

/** rbxasset URL of the Roblox family for a Figma family; overrides map family names to a family or a full URL. */
export function robloxFamily(family: string, overrides: Record<string, string> = {}): { url: string; substituted: boolean } {
  const key = family.trim().toLowerCase();
  const custom = Object.entries(overrides).find(([k]) => k.trim().toLowerCase() === key)?.[1];
  const name = custom ?? ROBLOX_FONTS[key] ?? DEFAULT_FONT;
  const url = /^rbxasset(id)?:\/\//.test(name) ? name : `rbxasset://fonts/families/${name.replace(/\s+/g, "")}.json`;
  const exact = custom !== undefined || name.toLowerCase() === key.replace(/\s+/g, "") || (key === "gotham" && name === "GothamSSm");
  return { url, substituted: !exact };
}

const WEIGHTS: [number, string][] = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Heavy"],
];

/** Closest Enum.FontWeight for a numeric weight. */
export function robloxWeight(weight: number): { value: number; name: string } {
  let best = WEIGHTS[3]!;
  for (const w of WEIGHTS) if (Math.abs(w[0] - weight) < Math.abs(best[0] - weight)) best = w;
  return { value: best[0], name: best[1] };
}
