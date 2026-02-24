export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // 1. 設定台灣日期 (避免 UTC 換日問題)
    const today = new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];

    if (action === "run") {
      let debugLog = `📅 執行日期標記: ${today}\n`;
      
      try {
        // --- 階段一：TradingView 掃描入庫 ---
        debugLog += "⏳ 正在從 TradingView 抓取資料...";
        const count = await this.ingestStocks(env, today);
        debugLog += ` ✅ 成功！入庫 ${count} 檔\n`;
        
        if (count === 0) return new Response(debugLog + "⚠️ 今日無符合條件之標的，任務終止。");

        // --- 階段二：逐檔進行 AI 分析 ---
        debugLog += "⏳ 正在啟動 AI 逐檔分析 (請耐心等待約 30-60 秒)...\n";
        const analysisCount = await this.processAllPending(env, today);
        debugLog += ` ✅ 分析完成：共完成 ${analysisCount} 檔標的\n`;

        // --- 階段三：SQL 彙整與 Telegram 推播 ---
        debugLog += "⏳ 正在產生 SQL 統計報告並發送 Telegram...";
        const reportStatus = await this.sendFinalReport(env, today);
        debugLog += ` ✅ ${reportStatus}\n`;

        return new Response(`🔥 任務執行成功！詳細日誌如下：\n\n${debugLog}`, {
          headers: { "Content-Type": "text/plain; charset=UTF-8" }
        });

      } catch (err) {
        const errorMsg = `❌ 執行崩潰：\n${err.message}\n\n堆疊：${err.stack}`;
        console.error(errorMsg);
        return new Response(errorMsg, { status: 500 });
      }
    }

    return new Response("請使用 ?action=run 啟動機器人");
  },

  // --- 模組 A: Ingester (掃描器) ---
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
      range: [0, 15] // 測試階段限制 15 檔避免超時
    };

    const response = await fetch(tvUrl, { method: "POST", body: JSON.stringify(tvPayload) });
    if (!response.ok) throw new Error(`TradingView API 失敗: ${response.status}`);
    
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

  // --- 模組 B: Processor (AI 分析迴圈) ---
  async processAllPending(env, today) {
    const pending = await env.DB.prepare(
      "SELECT id, ticker, company_name, close_price, sma_20, sma_50 FROM RawScans WHERE scan_date = ? AND is_analyzed = 0"
    ).bind(today).all();

    let successCount = 0;
    for (const stock of pending.results) {
      try {
        const aiResult = await this.analyzeWithGemini(env, stock);
        
        await env.DB.prepare(`
          INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(stock.id, stock.ticker, aiResult.sector, aiResult.catalyst, aiResult.stage, aiResult.heat, aiResult.strategy).run();

        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        successCount++;
        
        // 稍微停頓保護 API (Gemini 每分鐘限制)
        await new Promise(r => setTimeout(r, 1200)); 
      } catch (e) {
        console.error(`${stock.ticker} 分析失敗:`, e.message);
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = -1 WHERE id = ?").bind(stock.id).run();
      }
    }
    return successCount;
  },

async analyzeWithGemini(env, stock) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    
    // 增加：明確要求 AI 不要回傳任何 Markdown 標籤
    const prompt = `你是一位美股分析師。請分析 ${stock.ticker}。股價:${stock.close_price}。
    請搜尋近期利多原因。
    必須嚴格回傳純 JSON 格式，嚴禁包含 \`\`\`json 等標籤。
    格式範例：{"sector": "科技", "catalyst": "財報優於預期", "stage": "2", "heat": 5, "strategy": "突破買進"}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.1, // 降低隨機性，讓輸出更穩定
          response_mime_type: "application/json" // 強制模型輸出 JSON 格式 (Gemini 1.5 支援)
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API 請求失敗: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0].content) {
      throw new Error(`AI 回傳內容為空: ${JSON.stringify(data)}`);
    }

    let rawText = data.candidates[0].content.parts[0].text;
    
    try {
      // 1. 嘗試直接解析
      return JSON.parse(rawText);
    } catch (e) {
      // 2. 如果解析失敗，使用正規表達式強行提取 JSON 部分
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`無法從 AI 回傳中解析 JSON。原始文字: ${rawText.substring(0, 50)}...`);
    }
  },

  // --- 模組 D: Reporter (SQL 彙整) ---
  async sendFinalReport(env, today) {
    // 找出所有已分析標的 (不論熱度，先確保有資料)
    const picks = await env.DB.prepare(`
      SELECT * FROM AIAnalysis 
      WHERE scan_id IN (SELECT id FROM RawScans WHERE scan_date = ?)
      ORDER BY heat DESC
    `).bind(today).all();

    if (picks.results.length === 0) return "資料庫中無已分析標的可發送。";

    let msg = `🔥【美股實戰戰報】${today}\n\n`;
    picks.results.forEach(p => {
      msg += `📂 ${p.sector} | **${p.ticker}**\n`;
      msg += `* 🌡️ 熱度: ${p.heat}🔥 | ${p.strategy_tag}\n`;
      msg += `* 📰 ${p.catalyst}\n\n`;
    });

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg })
    });

    return tgRes.ok ? "Telegram 發送完成" : `Telegram 發送失敗: ${await tgRes.text()}`;
  }
};
