import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_REGISTRY_PATH = path.join(__dirname, "avatars_registry.json");
const CLIENT_MANIFEST_PATH = path.resolve(
  __dirname,
  "../client/public/models/avatars/avatars_manifest.json"
);

// Danh sách tên mặc định — style dân làng cho vui, tránh trùng trong cùng phòng
export const DEFAULT_NAMES = [
  "Tiểu Hiệp",
  "Long Hải",
  "Thanh huyền",
  "Kim Cúc",
  "Thanh Hiếu",
  "An Đì",
  "Yến",
  "Bích",
  "Nam",
  "Hưng Nghẹo",
];

// 4 Nhân vật Dân Làng 3D chuẩn nội bộ (AI Bot chỉ được phép dùng nhóm này — khóa độc quyền Avatar 3D Người Thật cho User!)
export const BUILTIN_VILLAGER_SPECS = Object.freeze({
  villager_cloak: {
    id: "villager_cloak",
    avatar: "/portraits/badges/villager_cloak.webp",
    avatarSource: "builtin_villager",
    botAllowed: true,
  },
  villager_true: {
    id: "villager_true",
    avatar: "/portraits/badges/villager.webp",
    avatarSource: "builtin_villager",
    botAllowed: true,
  },
  villager_female: {
    id: "villager_female",
    avatar: "/portraits/badges/villager_female.webp",
    avatarSource: "builtin_villager",
    botAllowed: true,
  },
  villager_elder: {
    id: "villager_elder",
    avatar: "/portraits/badges/villager_elder.webp",
    avatarSource: "builtin_villager",
    botAllowed: true,
  },
});

export const BUILTIN_VILLAGER_IDS = Object.freeze(Object.keys(BUILTIN_VILLAGER_SPECS));

let cachedCustomReadyMap = null;
let cachedAtMs = 0;

export function getReadyCustomHumanAvatarMap({ forceReload = false } = {}) {
  const now = Date.now();
  if (!forceReload && cachedCustomReadyMap && now - cachedAtMs < 5000) {
    return cachedCustomReadyMap;
  }
  const map = {};
  try {
    if (fs.existsSync(SERVER_REGISTRY_PATH)) {
      const reg = JSON.parse(fs.readFileSync(SERVER_REGISTRY_PATH, "utf8"));
      if (Array.isArray(reg?.customHumanAvatars)) {
        reg.customHumanAvatars.forEach((item) => {
          if (item?.id && item.status === "ready") {
            map[item.id] = {
              id: item.id,
              avatar: item.portraitBadge || "/portraits/badges/villager_cloak.webp",
              avatarSource: "custom_3d_human",
              botAllowed: false,
            };
          }
        });
      } else if (reg?.readyCustomHumanAvatars && typeof reg.readyCustomHumanAvatars === "object") {
        Object.entries(reg.readyCustomHumanAvatars).forEach(([k, v]) => {
          if (v && typeof v.avatar === "string") {
            map[k] = {
              id: k,
              avatar: v.avatar,
              avatarSource: "custom_3d_human",
              botAllowed: false,
            };
          }
        });
      }
    }
  } catch {
    // ignore malformed server registry
  }

  try {
    if (fs.existsSync(CLIENT_MANIFEST_PATH)) {
      const doc = JSON.parse(fs.readFileSync(CLIENT_MANIFEST_PATH, "utf8"));
      if (Array.isArray(doc?.customHumanAvatars)) {
        doc.customHumanAvatars.forEach((item) => {
          if (item?.id && item.status === "ready" && item.glbUrl) {
            map[item.id] = {
              id: item.id,
              avatar: item.portraitBadge || "/portraits/badges/villager_cloak.webp",
              avatarSource: "custom_3d_human",
              botAllowed: false,
            };
          }
        });
      }
    }
  } catch {
    // ignore missing client manifest on standalone cloud server
  }

  cachedCustomReadyMap = map;
  cachedAtMs = now;
  return map;
}

function hashSeedIndex(seed = "", mod = BUILTIN_VILLAGER_IDS.length) {
  const str = String(seed || "MASOI");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % Math.max(1, mod);
}

export function resolveCitizenAvatarSpec(
  requestedModelId,
  { fallbackSeed = "", forBot = false } = {}
) {
  const cleanId =
    typeof requestedModelId === "string"
      ? requestedModelId.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48)
      : "";

  if (cleanId && BUILTIN_VILLAGER_SPECS[cleanId]) {
    const spec = BUILTIN_VILLAGER_SPECS[cleanId];
    return {
      citizenModelId: spec.id,
      avatar: spec.avatar,
      avatarSource: spec.avatarSource,
    };
  }

  // Chỉ Người chơi thật / User mới được phép dùng Kho Avatar 3D Người Thật (AI Bot bị khóa 100%)
  if (!forBot && cleanId) {
    const customMap = getReadyCustomHumanAvatarMap();
    if (customMap[cleanId]) {
      return {
        citizenModelId: customMap[cleanId].id,
        avatar: customMap[cleanId].avatar,
        avatarSource: "custom_3d_human",
      };
    }
  }

  const fallbackId = BUILTIN_VILLAGER_IDS[hashSeedIndex(fallbackSeed, BUILTIN_VILLAGER_IDS.length)];
  const spec = BUILTIN_VILLAGER_SPECS[fallbackId];
  return {
    citizenModelId: spec.id,
    avatar: spec.avatar,
    avatarSource: spec.avatarSource,
  };
}

export function getDefaultName(existingNames = []) {
  const used = new Set(existingNames);
  const available = DEFAULT_NAMES.filter((n) => !used.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  let i = existingNames.length + 1;
  while (used.has(`Người Chơi ${i}`)) i++;
  return `Người Chơi ${i}`;
}

// 100% nội bộ — Cắt đứt hoàn toàn api.dicebear.com bên ngoài!
export function getAvatarUrl(seed = "") {
  return resolveCitizenAvatarSpec(null, { fallbackSeed: seed }).avatar;
}
