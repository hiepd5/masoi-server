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

export function getDefaultName(existingNames = []) {
  const used = new Set(existingNames);
  const available = DEFAULT_NAMES.filter((n) => !used.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Hết tên trong danh sách -> fallback đánh số
  let i = existingNames.length + 1;
  while (used.has(`Người Chơi ${i}`)) i++;
  return `Người Chơi ${i}`;
}

// Avatar tự sinh theo tên, không cần lưu file, không cần server riêng
export function getAvatarUrl(seed) {
  return `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(
    seed
  )}`;
}
