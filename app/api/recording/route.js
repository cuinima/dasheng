// 调试录音上传：把浏览器 MediaRecorder 采集到的音频 blob 存到 scripts/examples 下，
// 方便后续用真实音频重放、复现判分 bug。仅本地调试用途，无鉴权（与 /api/asr 一致）。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB 上限

export async function POST(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("audio")) {
    return Response.json({ error: "需要 audio 内容" }, { status: 400 });
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length) {
    return Response.json({ error: "空音频" }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) {
    return Response.json({ error: "音频过大" }, { status: 413 });
  }

  // 扩展名从 content-type 推断，默认 webm
  const ext = contentType.includes("ogg") ? "ogg" : "webm";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedName = (request.headers.get("x-recording-name") || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
  const stem = requestedName || `recording-${ts}`;

  try {
    const dir = path.join(process.cwd(), "scripts", "examples");
    await mkdir(dir, { recursive: true });
    let name;
    let file;
    for (let suffix = 1; ; suffix += 1) {
      name = `${stem}${suffix === 1 ? "" : `-${suffix}`}.${ext}`;
      file = path.join(dir, name);
      try {
        await writeFile(file, buf, { flag: "wx" });
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
    return Response.json({ ok: true, file: path.relative(process.cwd(), file) });
  } catch (err) {
    return Response.json({ error: err.message || "写入失败" }, { status: 500 });
  }
}
