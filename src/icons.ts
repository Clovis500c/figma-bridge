import { BridgeError } from "./bridge";

// Icons come from the Iconify API (200 000+ open-source icons, no key needed).
const API = "https://api.iconify.design";
const DEFAULT_SET = "lucide";
const cache = new Map<string, string>();

export function parseIconName(name: string): { prefix: string; icon: string } {
  const clean = name.trim().toLowerCase();
  const m = /^([a-z0-9-]+)[:/]([a-z0-9-]+)$/.exec(clean);
  if (m) return { prefix: m[1]!, icon: m[2]! };
  if (/^[a-z0-9-]+$/.test(clean)) return { prefix: DEFAULT_SET, icon: clean };
  throw new BridgeError(`Invalid icon name "${name}". Use "set:name", e.g. "lucide:house" or "tabler:user".`, "BAD_ARGS");
}

/** Returns the SVG markup of an icon at the given size, with `currentColor` replaced by `color`. */
export async function iconSvg(name: string, size = 24, color = "#111111"): Promise<string> {
  const { prefix, icon } = parseIconName(name);
  const key = `${prefix}:${icon}@${size}`;
  let svg = cache.get(key);
  if (!svg) {
    const res = await fetch(`${API}/${prefix}/${icon}.svg?height=${size}`, { signal: AbortSignal.timeout(15_000) });
    const text = res.ok ? await res.text() : "";
    if (!text.startsWith("<svg")) {
      throw new BridgeError(`Icon "${prefix}:${icon}" not found. Use search_icons to find the exact name.`, "NOT_FOUND");
    }
    svg = text;
    cache.set(key, svg);
  }
  return svg.replace(/currentColor/g, color);
}

export async function searchIcons(query: string, prefix?: string, limit = 24): Promise<string[]> {
  const params = new URLSearchParams({ query, limit: String(Math.max(32, limit)) });
  if (prefix) params.set("prefixes", prefix);
  const res = await fetch(`${API}/search?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new BridgeError(`Icon search failed: HTTP ${res.status}`, "DOWNLOAD");
  const data = (await res.json()) as { icons?: string[] };
  return (data.icons ?? []).slice(0, limit);
}
