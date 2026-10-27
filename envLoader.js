import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE_PATH = path.join(__dirname, ".env");

let loadedOnce = false;

export function loadLocalEnvSafe() {
  if (loadedOnce) return;
  loadedOnce = true;

  try {
    if (!fs.existsSync(ENV_FILE_PATH)) return;
    const raw = fs.readFileSync(ENV_FILE_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      // Không ghi đè biến môi trường đã được truyền trực tiếp từ Render / Shell
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Bỏ qua an toàn nếu không đọc được file .env
  }
}

loadLocalEnvSafe();
