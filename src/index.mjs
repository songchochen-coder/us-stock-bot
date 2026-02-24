/**
 * 美股量化分析機器人 - 專業架構版
 * 功能：自動掃描、D1 入庫、Gemini 逐檔分析、SQL 報告推播
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // 觸發入口：your-worker.workers.dev/?action=run
    if (action === "run") {
      ctx.waitUntil(this.runFullPipeline(env));
      return new Response("✅ 任務啟動：正在掃描美股並寫入資料庫，請留意 Telegram。", {
        headers: { "Content-Type": "text/plain; charset=UTF-8" }
      });
    }
    return new Response("請使用 ?action=run 觸發");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.runFullPipeline(env));
  },

  // --- 主流程控制 ---
  async runFullPipeline(env) {
    const today = new Date().toISOString().split('T')[0];
    console.log(`開始執行 ${today} 任務`);

    try {
      // 1. 掃描並入庫
      const count = await this.ingestStocks(env, today);
      if (count === 0) return;

      // 2. 逐檔分析 (自動處理待分析標的)
      await this.processAllPending(env, today);

      // 3. 從資料庫撈取結果並發送報告
      await this.sendFinalReport(env, today);
      
    } catch (err) {
      console.error("Pipeline 崩潰:", err);
      await this.postToTelegram(`❌ 系統執行失敗: ${err.message}`, env);
    }
  },

  // --- 模組 A: Ingester (TradingView 掃描器) ---
  async ingestStocks(env, today) {
    const tvUrl = "https://scanner.tradingview.com/america/scan";
    const tvPayload = {
      filter: [
        { left: "close", operation: "greater", right: 10 },
        { left: "Perf.1M", operation: "greater", right: 20 },
        { left: "market_cap_basic", operation: "greater", right: 5000000000 },
        { left: "average_volume_30d_calc", operation: "greater", right: 1500000 }
      ],
      markets: ["america"],
      symbols: { query: { types: ["stock"] }, tickers: [] },
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200"],
      sort: { sortBy: "Perf.1M", sortOrder: "desc" },
      range: [0, 20] // 限制前 20 檔，確保分析品質
    };

    const response = await fetch(tvUrl, {
      method: "POST",
      body: JSON.stringify(tvPayload)
    });
    
    const tvData = await response.json();
    const stocks = tvData.data || [];

    if (stocks.length > 0) {
      const stmt = env.DB.prepare(`
        INSERT INTO RawScans (scan_date, ticker, company_name, close_price, sma_20, sma_50, sma_200, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      const batch = stocks.map(s => stmt.bind(today, s.d[0], s.d[1], s.d[2], s.d[3], s.d[4], s.d[5]));
      await env.DB.batch(batch);
    }
    return stocks.length;
  },

  // --- 模組 B: Processor (AI 分析器) ---
  async processAllPending(env, today) {
    const pending = await env.DB.prepare(
      "SELECT * FROM RawScans WHERE scan_date = ? AND is_analyzed = 0"
    ).bind(today).all();

    for (const stock of pending.results) {
      try {
        const aiResult = await this.analyzeWithGemini(env, stock);
        
        // 寫入分析結果
        await env.DB.prepare(`
          INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, extension_risk, strategy_tag)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(stock.id, stock.ticker, aiResult.sector, aiResult.catalyst, aiResult.stage, aiResult.heat, aiResult.risk, aiResult.strategy).run();

        // 標記完成
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        
        // 延遲 2 秒避免 API 限流
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`${stock.ticker} 分析失敗:`, e);
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = -1 WHERE id = ?").bind(stock.id).run();
      }
    }
  },

  // --- 模組 C: AI 核心請求 ---
  async analyzeWithGemini(env, stock) {
    const prompt = `分析美股代號 ${stock.ticker} (${stock.company_name})。價格:${stock.close_price}, 均線:${stock.sma_20}/${stock.sma_50}/${stock.sma_200}。請搜尋最新財報與新聞，僅回傳 JSON: { "sector": "板塊", "catalyst": "原因", "stage": "1-4", "heat": 1-5, "risk": "低/中/高", "strategy": "標籤" }`;
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    return JSON.parse(text.replace(/```json|```/g, ""));
  },

  // --- 模組 D: Reporter (SQL 彙整) ---
  async sendFinalReport(env, today) {
    // 1. 統計板塊
    const sectors = await env.DB.prepare(`
      SELECT sector, COUNT(*) as count FROM AIAnalysis 
      WHERE scan_id IN (SELECT id FROM RawScans WHERE scan_date = ?)
      GROUP BY sector ORDER BY count DESC LIMIT 5
    `).bind(today).all();

    let msg = `🔥【美股量化交易戰報】${today}\n\n`;
    msg += `【一】資金板塊分佈：\n`;
    sectors.results.forEach((s, i) => msg += `${i+1}. ${s.sector}: ${s.count} 檔\n`);

    // 2. 篩選高熱度標的
    const picks = await env.DB.prepare(`
      SELECT * FROM AIAnalysis 
      WHERE heat >= 4 AND scan_id IN (SELECT id FROM RawScans WHERE scan_date = ?)
      ORDER BY heat DESC
    `).bind(today).all();

    msg += `\n【二】核心強勢股分析：\n`;
    picks.results.forEach(p => {
      msg += `### 📂 ${p.sector}\n🔹 **(${p.ticker})**\n* 📰 催化劑: ${p.catalyst}\n* 🌡️ 熱度: ${p.heat}🔥 | 策略: ${p.strategy_tag}\n\n`;
    });

    await this.postToTelegram(msg, env);
  },

  async postToTelegram(text, env) {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text })
    });
  }
};
