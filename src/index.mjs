export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // 強制設定為台灣日期 (避免 UTC 換日問題)
    const today = new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];

    if (action === "run") {
      ctx.waitUntil((async () => {
        try {
          // 1. 掃描
          const count = await this.ingestStocks(env, today);
          if (count === 0) {
            await this.postToTelegram(`⚠️ ${today} 無符合條件標的`, env);
            return;
          }

          // 2. 處理
          await this.processAllPending(env, today);

          // 3. 報告
          await this.sendFinalReport(env, today);
        } catch (err) {
          await this.postToTelegram(`❌ 執行失敗: ${err.message}`, env);
        }
      })());
      return new Response(`🚀 任務已啟動！今日標記日期：${today}`);
    }

    return new Response("使用 ?action=run 啟動機器人");
  },

  // --- 修正後的 Ingester ---
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
      range: [0, 15] // 先拿 15 檔測試穩定度
    };

    const response = await fetch(tvUrl, { method: "POST", body: JSON.stringify(tvPayload) });
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

async processAllPending(env, today) {
    // 1. 只抓取今天且尚未分析的原始資料
    const pending = await env.DB.prepare(
      "SELECT id, ticker, company_name, close_price, sma_20, sma_50 FROM RawScans WHERE scan_date = ? AND is_analyzed = 0"
    ).bind(today).all();

    // 2. 檢查是否有資料，避免空跑
    if (!pending.results || pending.results.length === 0) {
      console.log("今日無待分析標的");
      return;
    }

    for (const stock of pending.results) {
      try {
        const aiResult = await this.analyzeWithGemini(env, stock);
        
        // 3. 寫入分析表：確保 stock.id 是從 RawScans 抓出來的有效 ID
        await env.DB.prepare(`
          INSERT INTO AIAnalysis (scan_id, ticker, sector, catalyst, ai_stage, heat, strategy_tag)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
            stock.id,        // 這裡是關鍵，必須對應 RawScans 的 id
            stock.ticker, 
            aiResult.sector, 
            aiResult.catalyst, 
            aiResult.stage, 
            aiResult.heat, 
            aiResult.strategy
        ).run();

        // 4. 更新狀態
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = 1 WHERE id = ?").bind(stock.id).run();
        
        // 稍微停頓，保護 API
        await new Promise(r => setTimeout(r, 1500)); 

      } catch (e) {
        console.error(`${stock.ticker} 分析失敗:`, e.message);
        // 標記失敗，避免下次無限重試
        await env.DB.prepare("UPDATE RawScans SET is_analyzed = -1 WHERE id = ?").bind(stock.id).run();
      }
    }
  },
  // --- 修正後的 AI 模塊 (處理 JSON 格式) ---
async analyzeWithGemini(env, stock) {
    // 修正點：使用 v1beta 並確保模型名稱正確
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    
    const prompt = `分析美股代號 ${stock.ticker}。目前的價格為 ${stock.close_price}。請搜尋該公司近期催化劑與板塊。
    請嚴格僅回傳 JSON 格式，不要有任何 Markdown 標籤：
    { "sector": "板塊", "catalyst": "原因", "stage": "1-4", "heat": 5, "strategy": "標籤" }`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 } // 降低隨機性，確保 JSON 穩定
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API 報錯: ${response.status} - ${err}`);
    }

    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0].content) {
      throw new Error(`Gemini 回傳結構異常: ${JSON.stringify(data)}`);
    }

    const rawText = data.candidates[0].content.parts[0].text;
    const cleanJson = rawText.replace(/```json|```/gi, "").trim();
    return JSON.parse(cleanJson);
  },
  // --- 修正後的 Reporter ---
  async sendFinalReport(env, today) {
    const picks = await env.DB.prepare(`
      SELECT * FROM AIAnalysis 
      WHERE scan_id IN (SELECT id FROM RawScans WHERE scan_date = ?)
      ORDER BY heat DESC
    `).bind(today).all();

    if (picks.results.length === 0) return;

    let msg = `🔥【美股實戰戰報】${today}\n\n`;
    picks.results.forEach(p => {
      msg += `📂 ${p.sector} | **${p.ticker}**\n* 🌡️ 熱度: ${p.heat}🔥 | ${p.strategy_tag}\n* 📰 ${p.catalyst}\n\n`;
    });

    await this.postToTelegram(msg, env);
  },

  async postToTelegram(text, env) {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text })
    });
  }
};
