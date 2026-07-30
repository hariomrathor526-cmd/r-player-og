/**
 * Asset override map for the mirror.
 *
 * Keys are origin paths, values are CDN URLs of the copies uploaded from the
 * `assets` repo zip. Add a path to ENABLED_OVERRIDES to serve our own copy
 * instead of the origin's file. Empty by default: the origin always wins so
 * the mirror stays in sync with upstream updates.
 */
import batchCache from "@/assets/mirror/batch-cache.js.asset.json";
import chor from "@/assets/mirror/chor.js.asset.json";
import communityViewer from "@/assets/mirror/community-viewer.js.asset.json";
import corePlayerRadha from "@/assets/mirror/core-player-radha.js.asset.json";
import mainAppRadha from "@/assets/mirror/main-app-radha.js.asset.json";
import playCoreRadhaCss from "@/assets/mirror/play-core-radha.css.asset.json";
import playerRadhaRadha from "@/assets/mirror/player-radha-radha.js.asset.json";
import playerRadheRadhe from "@/assets/mirror/player-radhe-radhe.js.asset.json";
import playerRadhe from "@/assets/mirror/player-radhe.js.asset.json";
import playerWithoutError from "@/assets/mirror/player-wihout-error.js.asset.json";
import radhaCss from "@/assets/mirror/radha.css.asset.json";
import radhaJs from "@/assets/mirror/radha.js.asset.json";

export const ASSET_OVERRIDES: Record<string, string> = {
  "/js/batch-cache.js": batchCache.url,
  "/chor.js": chor.url,
  "/community-viewer.js": communityViewer.url,
  "/core-player-radha.js": corePlayerRadha.url,
  "/main-app-radha.js": mainAppRadha.url,
  "/play-core-radha.css": playCoreRadhaCss.url,
  "/player-radha-radha.js": playerRadhaRadha.url,
  "/player-radhe-radhe.js": playerRadheRadhe.url,
  "/player-radhe.js": playerRadhe.url,
  "/player-wihout-error.js": playerWithoutError.url,
  "/radha.css": radhaCss.url,
  "/radha.js": radhaJs.url,
};

/** Paths served from our own copies instead of the origin. */
export const ENABLED_OVERRIDES: ReadonlySet<string> = new Set<string>([]);

export function getOverrideUrl(pathname: string): string | undefined {
  if (!ENABLED_OVERRIDES.has(pathname)) return undefined;
  return ASSET_OVERRIDES[pathname];
}
