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
    // 💡 確保 AI 已經被正確注入
    if (!env.AI) {
      throw new Error("系統偵測到 env.AI 仍為空。請嘗試重新 Save and Deploy。");
    }

    // 💡 加大處理量到 10 檔，消化那 450 檔
    const query = await env.DB.prepare("SELECT * FROM RawScans WHERE is_analyzed = 0 LIMIT 10").all();
    const stocks = query.results || [];
    if (stocks.length === 0) return 0;

    let successCount = 0;
    for (const stock of stocks) {
      try {
        // 使用 Meta 的 Llama 3 模型，這是目前最穩定的
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'system', content: 'You are a professional stock analyst. Respond ONLY with valid JSON.' },
            { role: 'user', content: `Analyze ${stock.ticker} (Price: ${stock.close_price}). Format: {"sector":"","catalyst":"","heat":5,"strategy":""}` }
          ]
        });

        // 處理回傳
        const rawText = aiResponse.response || aiResponse;
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI output format error");
        
        const aiResult = JSON.parse(jsonMatch[0]);

        // 寫入分析結果
        await env.DB.prepare(`INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(stock.id, stock.ticker, aiResult.sector, aiResult.catalyst, "2", aiResult.heat, aiResult.strategy).run();

        // 標記成功
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        successCount++;
      } catch (e) {
        console.error(`分析失敗 ${stock.ticker}: ${e.message}`);
        // 失敗標記為 -1，避免死迴圈
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
