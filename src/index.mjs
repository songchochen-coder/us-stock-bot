export default {
  async fetch(request, env, ctx) {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // 測試 1: 檢查 env.DB 是否存在
      if (!env.DB) {
        return new Response("❌ 錯誤：env.DB 未定義！請檢查 Bindings 設定。");
      }

      // 測試 2: 嘗試寫入一筆測試資料
      const testTicker = "TEST-" + Math.floor(Math.random() * 1000);
      await env.DB.prepare(`
        INSERT INTO RawScans (scan_date, ticker, company_name, is_analyzed)
        VALUES (?, ?, '連線測試', 0)
      `).bind(today, testTicker).run();

      // 測試 3: 立即讀回剛才寫入的資料
      const result = await env.DB.prepare("SELECT * FROM RawScans WHERE ticker = ?")
        .bind(testTicker)
        .first();

      return new Response(`✅ 寫入成功！\n寫入代號: ${testTicker}\n資料庫 ID: ${result.id}\n日期: ${result.scan_date}`, {
        headers: { "Content-Type": "text/plain; charset=UTF-8" }
      });

    } catch (err) {
      return new Response(`❌ 執行出錯：\n${err.message}`, { status: 500 });
    }
  }
};
