export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const today = new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];

    if (action === "run") {
      let debugLog = `📅 標記日期: ${today}\n`;
      try {
        // 1. 抓取資料
        const count = await this.ingestStocks(env, today);
        debugLog += `✅ 成功入庫: ${count} 檔\n`;

        // 2. 診斷數量
        const check = await env.DB.prepare("SELECT COUNT(*) as c FROM RawScans WHERE is_analyzed = 0").first();
        debugLog += `🔍 診斷：目前資料庫中共有 ${check.c} 檔待分析標的\n`;

        // 3. 執行分析 (核心報錯區)
        debugLog += "⏳ 正在啟動 AI 逐檔分析...\n";
        const analysisCount = await this.processAllPending(env, today);
        debugLog += `✅ 分析完成：共完成 ${analysisCount} 檔\n`;

        // 4. 發送報告
        const reportStatus = await this.sendFinalReport(env, today);
        debugLog += `🚀 ${reportStatus}\n`;

        return new Response(debugLog, { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      } catch (err) {
        // 🌟 這裡會抓到 analyzeWithGemini 拋出的具體原因
        return new Response(`❌ 偵測到致命錯誤：\n${err.message}`, { status: 500 });
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

  async processAllPending(env, today) {
    const query = await env.DB.prepare("SELECT * FROM RawScans WHERE is_analyzed = 0 LIMIT 5").all();
    const stocks = query.results || [];
    
    let successCount = 0;
    for (const stock of stocks) {
      // 💡 這裡不使用 try/catch，讓錯誤直接拋到 fetch 層顯示出來
      const aiResult = await this.analyzeWithGemini(env, stock);
      
      await env.DB.prepare(`INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(stock.id, stock.ticker, aiResult.sector, aiResult.catalyst, aiResult.stage, aiResult.heat, aiResult.strategy).run();

      await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
      successCount++;
      await new Promise(r => setTimeout(r, 1000));
    }
    return successCount;
  },

async analyzeWithGemini(env, stock) {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ 
          parts: [{ 
            text: `Analyze US stock ${stock.ticker} for Feb 2026. 
            Search for latest news and catalysts. 
            Return ONLY a JSON object in this format: 
            {"sector":"Industry Name","catalyst":"Latest News","stage":"2","heat":5,"strategy":"Action"}` 
          }] 
        }],
        // 💡 修正點：移除可能報錯的 response_mime_type，改用最基礎的配置
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 200
        }
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Google API 報錯 (${response.status}): ${errBody}`);
    }

    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0].content) {
      throw new Error("AI 無法生成內容，請檢查 Key 是否有餘額或被限制");
    }

    const rawText = data.candidates[0].content.parts[0].text;
    
    // 💡 強力解析：從文字中抓取 JSON 部分
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI 回傳內容不包含 JSON");
    
    return JSON.parse(jsonMatch[0]);
  },

  async sendFinalReport(env, today) {
    const report = await env.DB.prepare(`SELECT * FROM AIAnalysis WHERE scan_id IN (SELECT id FROM RawScans WHERE is_analyzed = 1)`).all();
    const results = report.results || [];
    if (results.length === 0) return "⚠️ 資料庫中無分析結果可報告";

    let msg = `🔥【美股實戰戰報】\n\n`;
    results.forEach(p => { msg += `📂 ${p.sector} | **${p.ticker}**\n* 🌡️ 熱度: ${p.heat}🔥\n* 📰 ${p.catalyst}\n\n`; });

    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg })
    });

    await env.DB.prepare("UPDATE RawScans SET is_analyzed = 2 WHERE is_analyzed = 1").run();
    return "✅ Telegram 報告發送完成";
  }
};
