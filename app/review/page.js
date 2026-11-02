"use client";

import { useState } from "react";

export default function ReviewPage() {
  const [username, setUsername] = useState("");
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadReviews(event) {
    event.preventDefault();
    const name = username.trim();
    if (!name) {
      setError("请输入 OpenLearn 用户名");
      setLoaded(false);
      return;
    }

    setLoading(true);
    setError("");
    setLoaded(false);
    try {
      const response = await fetch(`/api/review?username=${encodeURIComponent(name)}`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "获取待复习句子失败");
      setItems(payload.list);
      setLoaded(true);
    } catch (err) {
      setError(err.message || "获取待复习句子失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="review-page">
      <header className="review-header">
        <a href="/">返回大声读 demo</a>
        <span>OPENLEARN</span>
      </header>

      <section className="review-main">
        <p className="review-kicker">Sentence review</p>
        <h1 className="review-title">待复习句子</h1>

        <form className="review-form" onSubmit={loadReviews}>
          <div className="review-field">
            <label htmlFor="review-username">OpenLearn 用户名</label>
            <input
              id="review-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="例如 test 或 xue"
            />
          </div>
          <button type="submit" disabled={loading}>
            {loading ? "读取中…" : "获取句子"}
          </button>
        </form>

        <p className={`review-status ${error ? "error" : ""}`} aria-live="polite">
          {error || (loaded ? `找到 ${items.length} 条待复习句子。` : "")}
        </p>

        {loaded && items.length > 0 && (
          <ol className="review-list">
            {items.map((item, index) => (
              <li className="review-item" key={item.sentence_id}>
                <div className="review-item-meta">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>Level {item.level} · {item.training_rule?.review_cycle_days ?? 0} 天间隔</span>
                </div>
                <p className="review-sentence">{item.content}</p>
                {item.meaning && <p className="review-meaning">{item.meaning}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}