// Chia vai trò 12 vai chuẩn V3.3: wolf, alpha_wolf, seer, guard, witch, hunter, cupid, mayor, tough_guy, cursed, tanner, villager

export const PLAYABLE_ROLE_KEYS = [
  "wolf",
  "alpha_wolf",
  "guard",
  "witch",
  "seer",
  "hunter",
  "cupid",
  "mayor",
  "tough_guy",
  "cursed",
  "tanner",
  "villager",
];

export const ROLE_LABELS = {
  wolf: "Sói",
  alpha_wolf: "Sói Đầu Đàn",
  seer: "Tiên Tri",
  guard: "Bảo Vệ",
  witch: "Phù Thủy",
  hunter: "Thợ Săn",
  cupid: "Thần Tình Yêu",
  mayor: "Trưởng Làng",
  tough_guy: "Người Cứng Cỏi",
  cursed: "Kẻ Bị Nguyền",
  tanner: "Chán Đời",
  villager: "Nông Dân",
};

export function isWolfTeamRole(role) {
  return role === "wolf" || role === "alpha_wolf";
}

// Số lượng Sói chuẩn theo số người chơi
export function calculateWolfCount(totalPlayers) {
  if (totalPlayers <= 8) return 2; // 6-8 người
  if (totalPlayers <= 10) return 3; // 9-10 người
  if (totalPlayers <= 12) return 4; // 11-12 người
  if (totalPlayers <= 15) return 4; // 13-15 người
  return 5; // 16-18 người
}

// Sinh cấu hình vai trò mặc định (Preset Cân Bằng) theo số lượng người
export function generateDefaultRoles(totalPlayers) {
  const count = Math.max(6, totalPlayers || 6);
  const wolfCount = calculateWolfCount(count);
  const seerCount = 1;
  const guardCount = 1;
  const witchCount = 1;
  const toughGuyCount = count >= 6 ? 1 : 0;
  const cursedCount = count >= 7 ? 1 : 0;
  const tannerCount = count >= 8 ? 1 : 0;

  const specialCount = wolfCount + seerCount + guardCount + witchCount + toughGuyCount + cursedCount + tannerCount;
  const villagerCount = Math.max(0, count - specialCount);

  return {
    wolf: wolfCount,
    alpha_wolf: 0,
    seer: seerCount,
    guard: guardCount,
    witch: witchCount,
    hunter: 0,
    cupid: 0,
    mayor: 0,
    tough_guy: toughGuyCount,
    cursed: cursedCount,
    tanner: tannerCount,
    villager: villagerCount,
  };
}

// Sinh cấu hình Mở Rộng V3.3 (Thợ Săn · Thần Tình Yêu · Sói Đầu Đàn · Trưởng Làng)
export function generateExpandedV33Roles(totalPlayers) {
  const count = Math.max(6, totalPlayers || 6);
  const totalWolves = calculateWolfCount(count);
  const alphaWolfCount = 1;
  const wolfCount = Math.max(0, totalWolves - alphaWolfCount);

  let remaining = count - totalWolves;
  const take = (want = 1) => {
    const got = Math.min(want, Math.max(0, remaining));
    remaining -= got;
    return got;
  };

  const seerCount = take(1);
  const hunterCount = take(1);
  const cupidCount = take(1);
  const mayorCount = take(1);
  const guardCount = take(1);
  const witchCount = take(1);
  const tannerCount = count >= 10 ? take(1) : 0;
  const cursedCount = count >= 12 ? take(1) : 0;
  const toughGuyCount = count >= 13 ? take(1) : 0;
  const villagerCount = Math.max(0, remaining);

  return {
    wolf: wolfCount,
    alpha_wolf: alphaWolfCount,
    seer: seerCount,
    guard: guardCount,
    witch: witchCount,
    hunter: hunterCount,
    cupid: cupidCount,
    mayor: mayorCount,
    tough_guy: toughGuyCount,
    cursed: cursedCount,
    tanner: tannerCount,
    villager: villagerCount,
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Chia vai trò tự động theo cấu hình tùy chỉnh hoặc mặc định
export function assignCustomRoles(playerIds, customRoleCounts) {
  const counts = customRoleCounts || generateDefaultRoles(playerIds.length);
  const roleList = [];

  Object.entries(counts).forEach(([role, qty]) => {
    for (let i = 0; i < qty; i++) {
      roleList.push(role);
    }
  });

  // Nếu số vai chưa đủ (fallback khẩn cấp), bù bằng Nông Dân
  while (roleList.length < playerIds.length) {
    roleList.push("villager");
  }

  const shuffledPlayers = shuffle(playerIds);
  const shuffledRoles = shuffle(roleList.slice(0, playerIds.length));

  const assignment = new Map();
  shuffledPlayers.forEach((pid, idx) => {
    assignment.set(pid, shuffledRoles[idx]);
  });

  return { assignment, counts };
}

// Giữ lại assignRoles để tương thích ngược
export function assignRoles(playerIds) {
  return assignCustomRoles(playerIds, generateDefaultRoles(playerIds.length));
}

