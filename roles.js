// Chia vai trò dựa trên tổng số người chơi
// Vai: wolf, seer, guard, witch, tanner (Chán Đời), villager (Nông dân)

export function calculateRoleCounts(totalPlayers) {
  if (totalPlayers < 6) {
    throw new Error("Cần tối thiểu 6 người để chia vai.");
  }

  const wolfCount = calculateWolfCount(totalPlayers);
  const seerCount = 1;
  const guardCount = 1;
  const witchCount = 1;
  const tannerCount = totalPlayers >= 8 ? 1 : 0;

  const specialCount = wolfCount + seerCount + guardCount + witchCount + tannerCount;
  const villagerCount = Math.max(0, totalPlayers - specialCount);

  return {
    wolf: wolfCount,
    seer: seerCount,
    guard: guardCount,
    witch: witchCount,
    tanner: tannerCount,
    villager: villagerCount,
  };
}

// Số lượng Sói theo mốc cố định (theo cách nhóm bạn chơi thực tế)
function calculateWolfCount(totalPlayers) {
  if (totalPlayers <= 8) return 2; // 6-8 người
  if (totalPlayers <= 10) return 3; // 9-10 người
  if (totalPlayers <= 12) return 4; // 11-12 người (nội suy)
  if (totalPlayers <= 15) return 4; // 13-15 người
  return 5; // 16-18 người
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Trả về Map<playerId, role>
export function assignRoles(playerIds) {
  const counts = calculateRoleCounts(playerIds.length);
  const roleList = [
    ...Array(counts.wolf).fill("wolf"),
    ...Array(counts.seer).fill("seer"),
    ...Array(counts.guard).fill("guard"),
    ...Array(counts.witch).fill("witch"),
    ...Array(counts.tanner).fill("tanner"),
    ...Array(counts.villager).fill("villager"),
  ];

  const shuffledPlayers = shuffle(playerIds);
  const shuffledRoles = shuffle(roleList);

  const assignment = new Map();
  shuffledPlayers.forEach((pid, idx) => {
    assignment.set(pid, shuffledRoles[idx]);
  });

  return { assignment, counts };
}

export const ROLE_LABELS = {
  wolf: "Sói",
  seer: "Tiên Tri",
  guard: "Bảo Vệ",
  witch: "Phù Thủy",
  tanner: "Chán Đời",
  villager: "Nông Dân",
};
