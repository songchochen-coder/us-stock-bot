export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const today = new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];

    if (action === "run") {
      let debugLog = `📅 執行日期: ${today}\n`;
      try {
        const count = await this.ingestStocks(env, today);
        debugLog += `✅ 入庫成功: ${count} 檔\n`;

        const check = await env.DB.prepare("SELECT COUNT(*) as c FROM RawScans WHERE is_analyzed = 0").first();
        debugLog += `🔍 待處理標的: ${check.c} 檔\n`;

        debugLog += "⏳ 使用 Cloudflare 原生 AI 進行分析...\n";
        const analysisCount = await this.processWithCFAI(env);
        debugLog += `✅ 分析完成: ${analysisCount} 檔\n`;

        const reportStatus = await this.sendFinalReport(env, today);
        debugLog += `🚀 ${reportStatus}\n`;

        return new Response(debugLog, { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      } catch (err) {
        return new Response(`❌ 致命錯誤: ${err.message}`, { status: 500 });
      }
    }
    return new Response("使用 ?action=run 啟動");
  },

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
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200"],
      sort: { sortBy: "Perf.1M", sortOrder: "desc" },
      range: [0, 15]
    };
    const response = await fetch(tvUrl, { method: "POST", body: JSON.stringify(tvPayload) });
    const tvData = await response.json();
    const stocks = tvData.data || [];
    if (stocks.length > 0) {
      const stmt = env.DB.prepare(`INSERT OR IGNORE INTO RawScans (scan_date, ticker, company_name, close_price, sma_20, sma_50, sma_200, is_analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
      const batch = stocks.map(s => stmt.bind(today, s.d[0], s.d[1], s.d[2], s.d[3], s.d[4], s.d[5]));
      await env.DB.batch(batch);
    }
    return stocks.length;
  },

async processWithCFAI(env) {
    // 💡 診斷：檢查 AI 物件是否存在
    if (!env.AI) {
      throw new Error("❌ [系統錯誤] env.AI 未定義。請確認：1. Binding 名稱叫 AI 2. 已重新按下 Save and Deploy。");
    }

    const query = await env.DB.prepare("SELECT * FROM RawScans WHERE is_analyzed = 0 LIMIT 5").all();
    const stocks = query.results || [];
    if (stocks.length === 0) return 0;

    let successCount = 0;
    for (const stock of stocks) {
      try {
        // 使用更穩定的模型名稱
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'system', content: 'You are a stock analyst. Reply only in valid JSON.' },
            { role: 'user', content: `Analyze ticker ${stock.ticker}. Return JSON: {"sector":"...","catalyst":"...","heat":5,"strategy":"..."}` }
          ]
        });

        const rawText = aiResponse.response || aiResponse; 
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        
        const aiResult = JSON.parse(jsonMatch[0]);

        await env.DB.prepare(`INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(stock.id, stock.ticker, aiResult.sector || "Tech", aiResult.catalyst || "N/A", "2", aiResult.heat || 3, aiResult.strategy || "Watch").run();

        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        successCount++;
      } catch (e) {
        // 如果單檔分析失敗，跳過並標記失敗，不卡住後面的 450 檔
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = -1 WHERE id = ?").bind(stock.id).run();
      }
    }
    return successCount;
  },

  async sendFinalReport(env, today) {
    const report = await env.DB.prepare(`SELECT * FROM AIAnalysis WHERE scan_id IN (SELECT id FROM RawScans WHERE is_analyzed = 1)`).all();
    const results = report.results || [];
    if (results.length === 0) return "⚠️ 無分析結果";

    let msg = `🔥【美股原生 AI 戰報】\n\n`;
    results.forEach(p => { msg += `📂 ${p.sector} | **${p.ticker}**\n* 🌡️ 熱度: ${p.heat}🔥\n* 📰 ${p.catalyst}\n\n`; });

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg })
    });

    if (tgRes.ok) {
      await env.DB.prepare("UPDATE RawScans SET is_analyzed = 2 WHERE is_analyzed = 1").run();
      return "✅ Telegram 發送完成";
    }
    return "❌ Telegram 發送失敗";
  }
};
