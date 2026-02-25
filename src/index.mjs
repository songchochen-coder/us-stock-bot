export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    // 設定台灣時區日期
    const today = new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];

    if (action === "run") {
      let debugLog = `📅 執行日期: ${today}\n`;
      try {
        // 1. 從 TradingView 抓取資料
        const count = await this.ingestStocks(env, today);
        debugLog += `✅ 成功入庫: ${count} 檔\n`;

        // 2. 診斷剩餘標的
        const check = await env.DB.prepare("SELECT COUNT(*) as c FROM RawScans WHERE is_analyzed = 0").first();
        debugLog += `🔍 待處理庫存: ${check.c} 檔\n`;

        // 3. 執行雙引擎分析 (每次處理 5-10 檔以防超時)
        debugLog += "⏳ 啟動雙引擎分析 (CF AI + Gemini)...\n";
        const analysisCount = await this.processHybridAI(env);
        debugLog += `✅ 分析完成: ${analysisCount} 檔\n`;

        // 4. 發送 Telegram 報告
        const reportStatus = await this.sendFinalReport(env, today);
        debugLog += `🚀 ${reportStatus}\n`;

        return new Response(debugLog, { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      } catch (err) {
        return new Response(`❌ 致命錯誤:\n${err.message}`, { status: 500 });
      }
    }
    return new Response("請使用 ?action=run 啟動機器人");
  },

  // 1. 資料入庫模組
  async ingestStocks(env, today) {
    const tvUrl = "https://scanner.tradingview.com/america/scan";
    const tvPayload = {
      filter: [
        { left: "close", operation: "greater", right: 10 },
        { left: "Perf.1M", operation: "greater", right: 15 },
        { left: "market_cap_basic", operation: "greater", right: 2000000000 }
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
      const stmt = env.DB.prepare(`
        INSERT OR IGNORE INTO RawScans (scan_date, ticker, company_name, close_price, sma_20, sma_50, sma_200, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      const batch = stocks.map(s => stmt.bind(today, s.d[0], s.d[1], s.d[2], s.d[3], s.d[4], s.d[5]));
      await env.DB.batch(batch);
    }
    return stocks.length;
  },

  // 2. 雙引擎分析核心
  async processHybridAI(env) {
    if (!env.AI) throw new Error("環境錯誤：找不到 env.AI 繫結");
    
    const query = await env.DB.prepare("SELECT * FROM RawScans WHERE is_analyzed = 0 LIMIT 5").all();
    const stocks = query.results || [];
    let successCount = 0;

    for (const stock of stocks) {
      try {
        let finalAnalysis = { sector: "未知", catalyst: "分析中", heat: 3, strategy: "觀望" };

        // --- 引擎 A: Cloudflare Workers AI (負責板塊識別) ---
        try {
          const cfRes = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [{ role: 'user', content: `Which stock sector does ${stock.ticker} belong to? Return only the sector name.` }]
          });
          finalAnalysis.sector = cfRes.response.replace(/[^a-zA-Z ]/g, "").trim();
        } catch (e) { console.error("CF AI 失敗，使用預設板塊"); }

        // --- 引擎 B: Gemini API (負責 2026 年最新聯網新聞) ---
// --- 引擎 B: Gemini API (強化聯網搜尋版) ---
try {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const gRes = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ 
        parts: [{ 
          // 💡 關鍵：明確要求搜尋最新新聞，並給出精確日期
          text: `Search for the very latest stock market news and financial catalysts for ${stock.ticker} on Feb 26, 2026. 
          If there is no news today, look for the most recent events in February 2026.
          Return ONLY JSON: {"catalyst":"簡短中文新聞摘要","heat":5,"strategy":"操作建議"}` 
        }] 
      }],
      // 💡 加入安全設定，避免因為財經預測被過濾
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    })
  });

  if (gRes.ok) {
    const gData = await gRes.json();
    // 檢查是否有回傳內容
    if (gData.candidates && gData.candidates[0].content) {
      const gText = gData.candidates[0].content.parts[0].text;
      const gJson = JSON.parse(gText.match(/\{[\s\S]*\}/)[0]);
      finalAnalysis.catalyst = gJson.catalyst;
      finalAnalysis.heat = gJson.heat;
      finalAnalysis.strategy = gJson.strategy;
    }
  }
} catch (e) {
  finalAnalysis.catalyst = "Gemini 聯網搜尋暫時受阻，請檢查 API 權限。";
}

        // --- 存入資料庫 ---
        await env.DB.prepare(`
          INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(stock.id, stock.ticker, finalAnalysis.sector, finalAnalysis.catalyst, "2", finalAnalysis.heat, finalAnalysis.strategy).run();

        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        successCount++;
        
      } catch (e) {
        console.error(`${stock.ticker} 分析失敗:`, e.message);
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = -1 WHERE id = ?").bind(stock.id).run();
      }
    }
    return successCount;
  },

  // 3. 報告發送模組
  async sendFinalReport(env, today) {
    const report = await env.DB.prepare(`
      SELECT * FROM AIAnalysis 
      WHERE scan_id IN (SELECT id FROM RawScans WHERE is_analyzed = 1)
      ORDER BY heat DESC
    `).all();

    const results = report.results || [];
    if (results.length === 0) return "⚠️ 資料庫中暫無分析成功的標的可發送";

    let msg = `🚀【美股混合 AI 實戰戰報】\n📅 日期: ${today}\n\n`;
    results.forEach(p => {
      msg += `📂 **${p.sector}** | \`$${p.ticker}\`\n`;
      msg += `🌡️ 熱度: ${"🔥".repeat(p.heat)} | 💡 ${p.strategy_tag}\n`;
      msg += `📰 ${p.catalyst}\n\n`;
    });
    msg += `✅ 以上為 AI 自動生成的即時分析，僅供參考。`;

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });

    if (tgRes.ok) {
      await env.DB.prepare("UPDATE RawScans SET is_analyzed = 2 WHERE is_analyzed = 1").run();
      return "Telegram 報告發送成功";
    }
    return "Telegram 發送失敗";
  }
};
