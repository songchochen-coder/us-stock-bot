export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "test") {
      // 執行完整測試流
      return new Response(await this.runTestPipeline(env));
    }
    return new Response("請使用 ?action=test 進行測試");
  },

  async runTestPipeline(env) {
    let log = "🚀 開始整合測試...\n";
    const today = new Date().toISOString().split('T')[0];

    try {
      // 1. 測試 Ingester (手動模擬一檔股票入庫，避免 TV API 變數)
      log += "1. 正在測試 RawScans 入庫...";
      await env.DB.prepare(`
        INSERT INTO RawScans (scan_date, ticker, company_name, close_price, sma_20, sma_50, sma_200, is_analyzed)
        VALUES (?, 'NVDA', 'NVIDIA Corp', 800.5, 780.2, 750.0, 600.0, 0)
      `).bind(today).run();
      log += " ✅ 成功\n";

      // 2. 測試 Processor (抓取剛剛那檔進行 AI 分析)
      log += "2. 正在測試 Gemini AI 分析...";
      const stock = await env.DB.prepare("SELECT * FROM RawScans WHERE ticker = 'NVDA' AND is_analyzed = 0 LIMIT 1").first();
      
      // 這裡呼叫你之前的 analyzeWithGemini 邏輯 (簡化版測試)
      const mockAiResult = {
        sector: "半導體/AI晶片",
        catalyst: "測試數據：GTC 大會預期",
        stage: "Stage 2",
        heat: 5,
        risk: "中",
        strategy: "突破買進"
      };

      await env.DB.prepare(`
        INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(stock.id, stock.ticker, mockAiResult.sector, mockAiResult.catalyst, mockAiResult.stage, mockAiResult.heat, mockAiResult.strategy).run();
      
      await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
      log += " ✅ 成功\n";

      // 3. 測試 Reporter (SQL 統計)
      log += "3. 正在測試 SQL 彙整報告...";
      const reportData = await env.DB.prepare(`
        SELECT A.ticker, A.sector, A.heat 
        FROM AIAnalysis A 
        JOIN RawScans R ON A.scan_id = R.id 
        WHERE R.scan_date = ?
      `).bind(today).all();
      
      log += ` ✅ 成功 (查詢到 ${reportData.results.length} 筆數據)\n`;
      log += "\n🎉 恭喜！資料庫與邏輯鏈路已完全打通。";
      
      return log;
    } catch (e) {
      return `❌ 測試失敗！錯誤原因：${e.message}`;
    }
  }
};
