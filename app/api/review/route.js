export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const username = new URL(request.url).searchParams.get("username")?.trim();
  if (!username) {
    return Response.json({ error: "请输入 OpenLearn 用户名" }, { status: 400 });
  }

  try {
    const openLearnUrl = new URL(
      "/review_list",
      process.env.OPENLEARN_API_URL || "http://127.0.0.1:5050",
    );
    openLearnUrl.searchParams.set("username", username);

    const response = await fetch(openLearnUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return Response.json(
        { error: `OpenLearn 请求失败（HTTP ${response.status}）` },
        { status: 502 },
      );
    }
    if (payload?.code !== 200 || !Array.isArray(payload.list)) {
      return Response.json(
        { error: payload?.msg || "OpenLearn 返回的数据格式不正确" },
        { status: 502 },
      );
    }

    return Response.json({ count: payload.list.length, list: payload.list });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "连接 OpenLearn 超时，请确认服务正在运行。"
      : "无法连接 OpenLearn，请确认服务正在运行。";
    return Response.json({ error: message }, { status: 502 });
  }
}