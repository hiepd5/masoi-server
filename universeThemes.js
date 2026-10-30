// Hệ Sinh Thái 3 Vũ Trụ V4.6: 🐺 Ma Sói Huyền Huyễn | 💼 Công Sở: Đại Chiến Bảng Lương | 🎒 Học Đường: Đại Chiến Sổ Đầu Bài
// Bảo toàn 100% toán học server/roles.js & gameEngine.js; lớp chuyển ngữ 0% bạo lực cho Công Sở & Học Đường.

export const VALID_UNIVERSES = ["classic", "office", "school"];

export function sanitizeUniverseId(raw) {
  const clean = String(raw || "").trim().toLowerCase();
  if (clean === "office" || clean === "congso" || clean === "work") return "office";
  if (clean === "school" || clean === "hocduong" || clean === "class") return "school";
  return "classic";
}

export const normalizeUniverseId = sanitizeUniverseId;

export const UNIVERSE_DEFAULT_SCENE_PRESET = {
  classic: "nordic_village_v3",
  office: "preset_office_penthouse_3d",
  school: "preset_school_sunset_3d",
};

export const UNIVERSE_QUICK_MATCH_TITLES = {
  classic: {
    normal: "🔥 Bàn Ghép Nhanh Sôi Động",
    turbo: "⚡ Bàn Ghép Nhanh (5 Phút)",
  },
  office: {
    normal: "💼 Group Trà Chiều Tầng 18 (Săn Sếp)",
    turbo: "⚡ Họp Khẩn Bảng Lương (5 Phút)",
  },
  school: {
    normal: "🎒 Hội Bàn Cuối Giờ Ra Chơi",
    turbo: "⚡ Tiết Sinh Hoạt Lớp (5 Phút)",
  },
};

export const UNIVERSE_BOT_NAMES = {
  classic: [
    "🤖 Bot Sói Xám", "🤖 Bot Cáo Đỏ", "🤖 Bot Cú Đêm", "🤖 Bot Thợ Săn",
    "🤖 Bot Cổ Thụ", "🤖 Bot Ánh Trăng", "🤖 Bot Sương Mù", "🤖 Bot Hổ Phách",
    "🤖 Bot Bão Tố", "🤖 Bot Lửa Trại", "🤖 Bot Bóng Đêm", "🤖 Bot Gió Bắc",
    "🤖 Bot Đá Ngầm", "🤖 Bot Sao Băng", "🤖 Bot Rừng Sâu", "🤖 Bot Lửa Thiêng",
  ],
  office: [
    "🤖 Minh KPI", "🤖 Vy Kế Toán", "🤖 Tuấn FixBug", "🤖 Lan Trà Sữa",
    "🤖 Hoàng Sale", "🤖 Thảo HR", "🤖 Khoa Designer", "🤖 Linh Content",
    "🤖 Đạt Thực Tập", "🤖 Trang Admin", "🤖 Huy DevOps", "🤖 Ngọc Pháp Chế",
    "🤖 Nam Bảo Trì", "🤖 Phương QA", "🤖 Khôi PM", "🤖 Yến Thu Mua",
  ],
  school: [
    "🤖 Nam Bàn Cuối", "🤖 Linh Trà Sữa", "🤖 Khoa Học Bá", "🤖 Vy Sao Đỏ",
    "🤖 Minh Ngủ Gật", "🤖 Thảo Văn Nghệ", "🤖 Tuấn Căng-Tin", "🤖 Ngọc Bí Thư",
    "🤖 Huy Thể Dục", "🤖 Trang Tổ Trưởng", "🤖 Đạt Chép Bài", "🤖 Yến Thủ Quỹ",
    "🤖 Khôi Tin Học", "🤖 Phương Đội Cờ", "🤖 Long Trực Nhật", "🤖 Mai Bàn Đầu",
  ],
};

const OFFICE_EXACT_OR_REGEX_RULES = [
  // Mở màn & Role Reveal
  [
    /🤖 Đã triệu hồi thêm (\d+) AI Bot lấp đủ (\d+) ghế\. Hãy xem kỹ lá bài định mệnh của bạn!/g,
    "💼 Đã gọi thêm $1 đồng nghiệp AI vào đủ $2 ghế phòng họp! Kiểm tra ngay chức danh bí mật của bạn!",
  ],
  [
    /Trò chơi bắt đầu với (\d+) người chơi(.*?)\. Hãy bí mật xem thân phận của mình!/g,
    "💼 Cuộc họp trà chiều bắt đầu với $1 nhân sự$2. Xem kỹ thẻ nhân viên bí mật trước khi Sếp vi hành!",
  ],
  // Đêm 1 & Gọi vai đêm
  [
    "💘 Đêm đầu tiên buông xuống... Thần Tình Yêu ơi, thức dậy! Hãy chọn 2 người để kết duyên sinh tử.",
    "🧋 Giờ tăng ca đầu tiên... Bà Tám Phòng Trà Nước ơi! Hãy ghép 2 đồng nghiệp vào chung Hợp Đồng Đôi Bạn Cùng Tiến!",
  ],
  [
    "Đêm đầu tiên buông xuống... Bảo Vệ ơi, thức dậy! Hãy chọn người bạn muốn bảo vệ đêm nay.",
    "🌙 Giờ chốt KPI bắt đầu... Trưởng Nhóm (Team Lead) ơi! Hãy ký bảo lãnh KPI cho 1 người tối nay.",
  ],
  [
    /Đêm thứ (\d+) bắt đầu\. Bảo Vệ ơi, hãy thức dậy\.\.\./g,
    "🌙 Ca trực tối thứ $1 bắt đầu. Trưởng Nhóm (Team Lead) ơi, hãy chọn người bảo lãnh KPI...",
  ],
  [
    "Thần Tình Yêu đã ngủ lại. Bảo Vệ ơi, hãy thức dậy và chọn người bảo vệ...",
    "🧋 Bà Tám đã về chỗ. Trưởng Nhóm (Team Lead) ơi, hãy thức dậy ký bảo lãnh KPI...",
  ],
  [
    "Bảo Vệ đã ngủ lại. Sói ơi, hãy thức dậy và chọn con mồi...",
    "🛡️ Trưởng Nhóm đã nộp báo cáo. 👔 Sếp Vi Hành ơi, mở bảng lương và chọn 1 người trừ sạch lương tháng này!",
  ],
  [
    "Sói đã ngủ lại. Phù Thủy ơi, hãy thức dậy...",
    "👔 Sếp đã khóa sổ đỏ. 🧮 Chị Kế Toán Trưởng ơi, mở quỹ chuyên cần cứu đói hay trừ phụ cấp?",
  ],
  [
    "Phù Thủy đã ngủ lại. Tiên Tri ơi, hãy thức dậy và soi một người...",
    "🧮 Chị Kế Toán đã cất sổ. 💻 Nhân Viên IT ơi, bật phần mềm quét IP Wi-Fi 1 ghế ngay!",
  ],
  // Bình minh & Kết quả đêm
  [
    "Trời đã sáng. Đêm qua không ai chết.",
    "☀️ Sáng thứ Hai bình yên! Tối qua không ai bị trừ sạch lương — bảng lương cả phòng nguyên vẹn!",
  ],
  [
    /Trời đã sáng\. Đêm qua (.+?) đã không qua khỏi\./g,
    "☀️ Bảng lương sáng nay vừa ting! Tối qua $1 đã bị gạch sạch lương tháng này và tạm rời cuộc họp!",
  ],
  // Hunter / Senior giữ pass server
  [
    /🏹 Khoan đã! Thợ Săn (.*?) còn 15 giây hơi thở cuối để bóp cò bắn đạn bạc trả thù!/g,
    "📁 Khoan đã! Senior Giữ Pass Server $1 còn 15 giây cuối để tung Email CC toàn công ty kéo 1 người bay lương cùng!",
  ],
  [
    "🏹 Hết thời gian! Thợ Săn đã gục xuống mà không bóp cò.",
    "📁 Hết giờ! Senior đã bàn giao máy mà không bấm gửi Email CC.",
  ],
  [
    /🏹 ĐOÀNG!! Đạn bạc cuối cùng của Thợ Săn (.*?) đã hạ gục (.+?)!/g,
    "📁 BẤM GỬI!! Email CC toàn công ty của Senior $1 đã kéo $2 bay sạch bảng lương theo!",
  ],
  // Mayor / Chủ tịch công đoàn
  [
    /👑 (.+?) giơ cao Quyền Trượng Vàng công bố thân phận Trưởng Làng — lá phiếu từ nay tính x2!/g,
    "🏅 $1 đập bàn giơ cao Con Dấu Công Đoàn công bố Chủ Tịch Công Đoàn — lá phiếu từ nay tính gấp đôi (x2)!",
  ],
  // Thảo luận & Biểu quyết
  [
    /☀️ Cả làng thảo luận trong (\d+) giây\. Nếu tất cả đồng ý bỏ qua có thể kết thúc sớm\./g,
    "☕ Cả phòng họp giải lao truy tìm nick Sếp trong $1 giây! Nếu cả phòng đồng ý có thể chốt vote sớm.",
  ],
  [
    "Hết giờ thảo luận. Mời cả làng đề cử người nghi ngờ.",
    "🗳️ Hết giờ trà chiều! Mời cả phòng chỉ tay đề cử người nghi là Sếp nằm vùng.",
  ],
  [
    "Không ai bị đề cử. Đêm mới lại đến...",
    "😮‍💨 Không ai bị đưa lên họp kiểm điểm. Ca trực tối mới lại bắt đầu...",
  ],
  [
    /(.+?) bị đề cử nhiều nhất\. Mời lần lượt lên biện hộ\./g,
    "⚖️ $1 bị nghi là Sếp nhiều nhất! Mời lần lượt mở mic giải trình KPI.",
  ],
  [
    /🎤 Mời (.+?) lên biện hộ\. \((\d+) giây\)/g,
    "🎤 Mời $1 giải trình trước phòng họp ($2 giây).",
  ],
  [
    /⚖️ Mời cả làng vote cho (.+?): Treo cổ hay Tha\./g,
    "⚖️ Mời cả phòng biểu quyết cho $1: Mời Ra Khỏi Group hay Giữ Lại?",
  ],
  [
    /Tiếp theo: Mời cả làng vote cho (.+?): Treo cổ hay Tha\./g,
    "⚖️ Tiếp theo: Mời cả phòng biểu quyết cho $1: Mời Ra Khỏi Group hay Giữ Lại?",
  ],
  [
    /Làng đã quyết định! (.+?) sẽ rời khỏi ván đấu\. Xin hãy giữ im lặng tuyệt đối\./g,
    "📤 Phòng họp đã chốt! $1 chính thức bị mời ra khỏi Group Trà Chiều. Vui lòng tắt mic giữ bí mật nhé!",
  ],
  [
    /💔 Tơ hồng đứt đoạn! Tình Nhân (.+?) không chịu nổi nỗi đau đã gục ngã theo!/g,
    "🧋 Đôi bạn chung hợp đồng! $1 quyết định nộp đơn nghỉ phép đi cùng đồng chí của mình luôn!",
  ],
  [
    /Làng đã tha (.+?)! Không ai bị xử tử hôm nay\./g,
    "🤝 Cả phòng quyết định giữ $1 ở lại group! Không ai bị mời ra hôm nay.",
  ],
  // Kết thúc ván đấu
  [
    "💘 Trò chơi kết thúc! Cặp Đôi Định Mệnh vượt qua chiến tuyến chiến thắng trọn vẹn!",
    "🧋 Kết thúc cuộc họp! Đôi Bạn Chung Hợp Đồng lách qua mọi đợt cắt giảm và ẵm trọn thưởng quý!",
  ],
  [
    "Trò chơi kết thúc! Phe Sói chiến thắng. Bóng tối đã nuốt chửng cả làng...",
    "👔 Cuộc họp kết thúc! Phe Sếp Vi Hành thắng áp đảo — Quỹ lương tháng này đã bị thu hồi sạch!",
  ],
  [
    "Trò chơi kết thúc! Phe Dân chiến thắng. Ánh sáng công lý đã xua tan bóng tối!",
    "🎉 Cuộc họp kết thúc! Hội Nhân Viên đại thắng — Đã lật tẩy hết nick clone của Sếp, bảo toàn 100% lương thưởng tháng 13!",
  ],
  [
    "Trò chơi kết thúc! Chán Đời thắng riêng — người này thực sự muốn bị treo cổ!",
    "🏖️ Cú lừa thế kỷ! Thánh Săn Đền Bù thắng độc lập — vừa ôm 6 tháng lương đền bù vừa xách vali bay thẳng đi Phú Quốc!",
  ],
];

const SCHOOL_EXACT_OR_REGEX_RULES = [
  // Mở màn & Role Reveal
  [
    /🤖 Đã triệu hồi thêm (\d+) AI Bot lấp đủ (\d+) ghế\. Hãy xem kỹ lá bài định mệnh của bạn!/g,
    "🎒 Đã gọi thêm $1 bạn cùng lớp AI ngồi đủ $2 bàn! Mở cặp xem ngay nhiệm vụ bí mật của bạn!",
  ],
  [
    /Trò chơi bắt đầu với (\d+) người chơi(.*?)\. Hãy bí mật xem thân phận của mình!/g,
    "🎒 Giờ ra chơi bắt đầu với $1 thành viên lớp$2. Xem kỹ thẻ học sinh bí mật kẻo Cô Chủ Nhiệm phát hiện!",
  ],
  // Đêm 1 & Gọi vai đêm
  [
    "💘 Đêm đầu tiên buông xuống... Thần Tình Yêu ơi, thức dậy! Hãy chọn 2 người để kết duyên sinh tử.",
    "💌 Tiết tự học đầu tiên... Bà Mối Bàn Cuối ơi! Hãy chọn 2 bạn ghép thành Đôi Bạn Cùng Bàn!",
  ],
  [
    "Đêm đầu tiên buông xuống... Bảo Vệ ơi, thức dậy! Hãy chọn người bạn muốn bảo vệ đêm nay.",
    "🌙 Giờ kiểm tra bài bắt đầu... Lớp Phó Đỡ Lời ơi! Chọn 1 bạn xin phép đi bê tập vở giúp trường tối nay.",
  ],
  [
    /Đêm thứ (\d+) bắt đầu\. Bảo Vệ ơi, hãy thức dậy\.\.\./g,
    "🌙 Buổi truy bài thứ $1 bắt đầu. Lớp Phó Đỡ Lời ơi, chọn bạn để đỡ lời ngay...",
  ],
  [
    "Thần Tình Yêu đã ngủ lại. Bảo Vệ ơi, hãy thức dậy và chọn người bảo vệ...",
    "💌 Bà Mối đã cất thư tay. Lớp Phó Đỡ Lời ơi, chọn 1 bạn xin phép ra ngoài bê vở...",
  ],
  [
    "Bảo Vệ đã ngủ lại. Sói ơi, hãy thức dậy và chọn con mồi...",
    "🙋 Lớp Phó đã về chỗ. 👩‍🏫 Cô Chủ Nhiệm Vi Hành ơi, mở Sổ Đầu Bài và chọn 1 bạn ghi tên hạ hạnh kiểm!",
  ],
  [
    "Sói đã ngủ lại. Phù Thủy ơi, hãy thức dậy...",
    "👩‍🏫 Cô Chủ Nhiệm đã gấp sổ. 📒 Thư Ký Sổ Đầu Bài ơi, muốn cộng điểm phát biểu cứu bạn hay trừ thi đua ai?",
  ],
  [
    "Phù Thủy đã ngủ lại. Tiên Tri ơi, hãy thức dậy và soi một người...",
    "📒 Thư Ký đã cất bút. 🎽 Sao Đỏ Trực Tuần ơi, giơ kính lúp soi thẻ học sinh 1 ghế ngay!",
  ],
  // Bình minh & Kết quả
  [
    "Trời đã sáng. Đêm qua không ai chết.",
    "☀️ Trống vào lớp vang lên! Tối qua không ai bị ghi Sổ Đầu Bài — cả lớp giữ trọn điểm thi đua tuần!",
  ],
  [
    /Trời đã sáng\. Đêm qua (.+?) đã không qua khỏi\./g,
    "☀️ Trống vào tiết vang lên! $1 vừa bị ghi tên chình ình vào Sổ Đầu Bài và phải ra hành lang đứng!",
  ],
  // Hunter / Chiến thần thưa cô
  [
    /🏹 Khoan đã! Thợ Săn (.*?) còn 15 giây hơi thở cuối để bóp cò bắn đạn bạc trả thù!/g,
    "📢 Khoan đã! Chiến Thần 'Thưa Cô Bạn Kia Cũng...' $1 còn 15 giây cuối để chỉ tay kéo 1 bạn lên bảng đứng chung!",
  ],
  [
    "🏹 Hết thời gian! Thợ Săn đã gục xuống mà không bóp cò.",
    "📢 Hết giờ! Bạn ấy đã ngoan ngoãn xách cặp ra hành lang mà không chỉ điểm ai.",
  ],
  [
    /🏹 ĐOÀNG!! Đạn bạc cuối cùng của Thợ Săn (.*?) đã hạ gục (.+?)!/g,
    "📢 THƯA CÔ!! Màn chỉ điểm thần sầu của $1 đã kéo luôn $2 vào Sổ Đầu Bài đứng chung!",
  ],
  // Mayor / Lớp trưởng
  [
    /👑 (.+?) giơ cao Quyền Trượng Vàng công bố thân phận Trưởng Làng — lá phiếu từ nay tính x2!/g,
    "⭐ $1 giơ cao Huy Hiệu Liên Đội công bố Lớp Trưởng Gương Mẫu — lá phiếu biểu quyết lớp từ nay tính x2!",
  ],
  // Thảo luận & Vote
  [
    /☀️ Cả làng thảo luận trong (\d+) giây\. Nếu tất cả đồng ý bỏ qua có thể kết thúc sớm\./g,
    "🎒 Cả lớp bàn tán giờ ra chơi tìm nick Cô Chủ Nhiệm trong $1 giây! Đồng thuận cả lớp có thể vote sớm.",
  ],
  [
    "Hết giờ thảo luận. Mời cả làng đề cử người nghi ngờ.",
    "🗳️ Hết giờ ra chơi! Mời cả lớp chỉ tay đề cử người nghi là nick clone Giáo Viên.",
  ],
  [
    "Không ai bị đề cử. Đêm mới lại đến...",
    "😮‍💨 Cả lớp bao che nhau không đề cử ai. Giờ truy bài mới lại bắt đầu...",
  ],
  [
    /(.+?) bị đề cử nhiều nhất\. Mời lần lượt lên biện hộ\./g,
    "⚖️ $1 bị cả lớp nghi nhiều nhất! Mời đứng lên bục giảng giải thích.",
  ],
  [
    /🎤 Mời (.+?) lên biện hộ\. \((\d+) giây\)/g,
    "🎤 Mời $1 lên bục giảng thanh minh ($2 giây).",
  ],
  [
    /⚖️ Mời cả làng vote cho (.+?): Treo cổ hay Tha\./g,
    "⚖️ Cả lớp biểu quyết cho $1: Mời Ra Khỏi Nhóm Lớp hay Giữ Lại?",
  ],
  [
    /Tiếp theo: Mời cả làng vote cho (.+?): Treo cổ hay Tha\./g,
    "⚖️ Tiếp theo: Cả lớp biểu quyết cho $1: Mời Ra Khỏi Nhóm Lớp hay Giữ Lại?",
  ],
  [
    /Làng đã quyết định! (.+?) sẽ rời khỏi ván đấu\. Xin hãy giữ im lặng tuyệt đối\./g,
    "🚪 Cả lớp đã chốt! $1 bị mời ra khỏi nhóm bàn cuối tiết này. Giữ trật tự không nhắc bài nhé!",
  ],
  [
    /💔 Tơ hồng đứt đoạn! Tình Nhân (.+?) không chịu nổi nỗi đau đã gục ngã theo!/g,
    "💌 Đôi bạn cùng bàn có phúc cùng hưởng! $1 tự nguyện xách ghế ra hành lang đứng cùng bạn mình luôn!",
  ],
  [
    /Làng đã tha (.+?)! Không ai bị xử tử hôm nay\./g,
    "🙌 Cả lớp thống nhất giữ $1 ngồi lại bàn! Không ai bị mời ra tiết này.",
  ],
  // Kết thúc ván đấu
  [
    "💘 Trò chơi kết thúc! Cặp Đôi Định Mệnh vượt qua chiến tuyến chiến thắng trọn vẹn!",
    "💌 Tan trường! Đôi Bạn Cùng Bàn phối hợp ăn ý vượt qua mọi bài kiểm tra và chiến thắng rực rỡ!",
  ],
  [
    "Trò chơi kết thúc! Phe Sói chiến thắng. Bóng tối đã nuốt chửng cả làng...",
    "👩‍🏫 Trống tan tiết! Cô Chủ Nhiệm & Giám Thị thắng áp đảo — Sổ Đầu Bài tuần này kín đặc tên hội bàn cuối!",
  ],
  [
    "Trò chơi kết thúc! Phe Dân chiến thắng. Ánh sáng công lý đã xua tan bóng tối!",
    "🎉 Trống ra chơi vang lên! Hội Học Sinh Bàn Cuối đại thắng — Đã phát hiện hết nick clone của Thầy Cô, cả lớp đạt Cờ Thi Đua Nhất Tuần!",
  ],
  [
    "Trò chơi kết thúc! Chán Đời thắng riêng — người này thực sự muốn bị treo cổ!",
    "🧋 Đỉnh cao diễn xuất! Thánh Thèm Đi Căng-Tin thắng độc lập — lừa cả lớp mời ra ngoài để chạy thẳng xuống Căng-tin hút trà sữa full topping!",
  ],
];

// Từ điển thay thế từ vựng cho câu thoại AI Bot tranh biện (`devSandbox.js`)
const OFFICE_WORD_REPLACEMENTS = [
  [/Sói Đầu Đàn/gi, "Chủ Tịch CEO"],
  [/bầy Sói|phe Sói|Ma Sói|Sói/gi, "Sếp nằm vùng"],
  [/Trưởng Làng/gi, "Chủ Tịch Công Đoàn"],
  [/Bảo Vệ/gi, "Team Lead"],
  [/Phù Thủy/gi, "Chị Kế Toán"],
  [/Tiên Tri/gi, "IT soi IP"],
  [/Kẻ Bị Nguyền/gi, "Thực Tập Sinh quay xe"],
  [/dân lương thiện|người dân/gi, "nhân viên chăm chỉ"],
  [/cả làng|ngôi làng|làng/gi, "cả phòng họp"],
  [/treo nhầm|treo cổ|treo tôi|xử tử/gi, "kick nhầm khỏi group"],
  [/cái chết của/gi, "vụ trừ sạch lương của"],
  [/nằm xuống|gục/gi, "bay bảng lương"],
  [/Đêm qua/gi, "Tối tăng ca qua"],
];

const SCHOOL_WORD_REPLACEMENTS = [
  [/Sói Đầu Đàn/gi, "Thầy Giám Thị"],
  [/bầy Sói|phe Sói|Ma Sói|Sói/gi, "nick Cô Chủ Nhiệm"],
  [/Trưởng Làng/gi, "Lớp Trưởng"],
  [/Bảo Vệ/gi, "Lớp Phó"],
  [/Phù Thủy/gi, "Thư Ký Sổ Đầu Bài"],
  [/Tiên Tri/gi, "Sao Đỏ"],
  [/Kẻ Bị Nguyền/gi, "Tổ Trưởng ngầm"],
  [/dân lương thiện|người dân/gi, "học sinh ngoan"],
  [/cả làng|ngôi làng|làng/gi, "cả lớp"],
  [/treo nhầm|treo cổ|treo tôi|xử tử/gi, "mời nhầm ra hành lang"],
  [/cái chết của/gi, "vụ bị ghi Sổ Đầu Bài của"],
  [/nằm xuống|gục/gi, "bị ghi sổ đỏ"],
  [/Đêm qua/gi, "Giờ truy bài qua"],
];

export function adaptTextForUniverse(rawText, universeId = "classic") {
  if (!rawText || typeof rawText !== "string") return rawText;
  const uid = sanitizeUniverseId(universeId);
  if (uid === "classic") return rawText;

  const rules = uid === "office" ? OFFICE_EXACT_OR_REGEX_RULES : SCHOOL_EXACT_OR_REGEX_RULES;
  for (const [pattern, replacement] of rules) {
    if (typeof pattern === "string") {
      if (rawText === pattern) return replacement;
    } else if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      if (pattern.test(rawText)) {
        pattern.lastIndex = 0;
        return rawText.replace(pattern, replacement);
      }
    }
  }

  let adapted = rawText;
  const wordRules = uid === "office" ? OFFICE_WORD_REPLACEMENTS : SCHOOL_WORD_REPLACEMENTS;
  for (const [regex, rep] of wordRules) {
    adapted = adapted.replace(regex, rep);
  }
  return adapted;
}
