// Chia vai trò: wolf, seer, guard, witch, tough_guy, cursed, tanner, villager

export const ROLE_LABELS = {
  wolf: "Sói",
  seer: "Tiên Tri",
  guard: "Bảo Vệ",
  witch: "Phù Thủy",
  tough_guy: "Người Cứng Cỏi",
  cursed: "Kẻ Bị Nguyền",
  tanner: "Chán Đời",
  villager: "Nông Dân",
};

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
    seer: seerCount,
    guard: guardCount,
    witch: witchCount,
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

