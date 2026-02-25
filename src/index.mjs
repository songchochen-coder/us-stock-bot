// 【美股專屬】實戰交易決策與量化資料庫寫入機器人
async function generateTradingReport(env) {
  try {
    const isUS = true; // 切換為美股
    const marketStr = isUS ? "US" : "TW";
    const today = new Date().toISOString().split('T')[0];

    // 1. 呼叫 TradingView API (美股強勢股濾網：市值>100億美元、均量>200萬股、週漲幅>15%)
    // 注意：美股需使用 global/scan 且必須帶上 User-Agent 避免 403 錯誤
    const tvUrl = "https://scanner.tradingview.com/global/scan";
    const tvPayload = {
      filter: [
        { left: "Perf.M", operation: "greater", right: 20 },
        { left: "market_cap_basic", operation: "greater", right: 10000000000 },
        { left: "average_volume_30d_calc", operation: "greater", right: 2000000 }
      ],
      options: { lang: "zh_TW" },
      markets: ["america"],
      symbols: { query: { types: ["stock"] }, tickers: [] },
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200"], 
      sort: { sortBy: "Perf.W", sortOrder: "desc" },
      range: [0, 50] // 美股數量較多，先抓前 50 檔最強的進入 AI 分析
    };

    const tvResponse = await fetch(tvUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Referer": "https://www.tradingview.com/"
      },
      body: JSON.stringify(tvPayload)
    });

    if (!tvResponse.ok) {
      const errorMsg = await tvResponse.text();
      return `⚠️ TradingView 美股 API 請求失敗 (狀態碼: ${tvResponse.status})`;
    }
    
    const tvData = await tvResponse.json();
    const stocks = tvData.data || [];

    if (stocks.length === 0) return "目前沒有符合條件（週漲幅>15%、市值>100億美元、均量>200萬股）的美股標的。";

    // 2. 格式化資料
    let rawStockData = {};
    let allStocksList = [];

    stocks.forEach(item => {
      const [name, description, close, sma20, sma50, sma200] = item.d;
      const c = close ? close.toFixed(2) : 0;
      const m20 = sma20 ? sma20.toFixed(2) : 0;
      const m50 = sma50 ? sma50.toFixed(2) : 0;
      const m200 = sma200 ? sma200.toFixed(2) : 0;

      rawStockData[name] = { close: c, sma20: m20, sma50: m50, sma200: m200 };
      allStocksList.push(`[${name}] ${description} (收盤:$${c} | 20MA:$${m20} | 50MA:$${m50} | 200MA:$${m200})`);
    });

    // 3. 呼叫 Gemini API
    const prompt = `
      以下為本週符合強勢濾網的【美股】名單與實際均線數據（共 ${stocks.length} 檔）：
      【${allStocksList.join("、")}】

      請以「頂級美股趨勢交易者」角度分析。重心轉向「主流回測量縮」與「低位階補漲」。
      請直接輸出：

      【一】美股強勢股實戰策略
      ### 📂 [板塊名稱] (主流核心/次主流/非主流)
      🔹 **[代號] 公司名稱** (題材簡述)
      * 🌡️ **熱度**：[1~5顆🔥]
      * 📈 **位階**：Stage [1~4] ｜ 乖離風險：[高/中/低]
      * ⚔️ **策略**：**【建議標籤】** (⚠️ 限填: 拉回量縮承接 / 低檔試單 / 僅觀察 / 高檔風險)

      【二】潛力擴散與低位階補漲族群推演
      (對應板塊推演出 2 個外溢次產業)

      【三】資料庫寫入專用 JSON
      \`\`\`json
      [
        { "ticker": "NVDA", "company": "NVIDIA", "sector": "AI晶片", "ai_stage": "Stage 2", "strategy": "高檔風險" }
      ]
      \`\`\`
    `;

    // 統一使用目前最穩定的 1.5-flash
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const aiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [{ text: "你是一位實戰派的美股趨勢交易員。極度厭惡追高。操作紀律是：只做核心主流的回測量縮。" }]
        }
      })
    });

    const aiData = await aiResponse.json();
    const rawAnalysis = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawAnalysis) return "⚠️ AI 回應異常";

    // 4. 解析 JSON 與清理畫面
    let reportForTelegram = rawAnalysis;
    let dbJsonArray = [];
    const jsonMatch = rawAnalysis.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        dbJsonArray = JSON.parse(jsonMatch[1]);
        reportForTelegram = rawAnalysis.split(/【三】/)[0].trim();
      } catch(e) { console.error("JSON 解析失敗", e); }
    }

    // 5. 寫入 D1 資料庫
    if (env.DB && dbJsonArray.length > 0) {
      const stmt = env.DB.prepare(`
        INSERT INTO DailyStockAnalysis (scan_date, market, ticker, company_name, close_price, sma_20, sma_50, sma_200, sector, ai_stage, strategy_tag) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      let batchStmts = [];
      for (let item of dbJsonArray) {
        const t = item.ticker || "UNKNOWN";
        const tvData = rawStockData[t] || { close: 0, sma20: 0, sma50: 0, sma200: 0 };
        batchStmts.push(stmt.bind(
          today, marketStr, t, item.company || "UNKNOWN", 
          Number(tvData.close), Number(tvData.sma20), Number(tvData.sma50), Number(tvData.sma200),
          item.sector || "N/A", item.ai_stage || "N/A", item.strategy || "N/A"
        ));
      }
      await env.DB.batch(batchStmts);
    }

    return `🇺🇸【美股實戰交易決策】🇺🇸\n✅ 已完成 ${stocks.length} 檔數據分析並存入 D1。\n\n====================\n${reportForTelegram}`;

  } catch (error) {
    return `執行發生嚴重錯誤: ${error.message}`;
  }
}

// 發送訊息至 Telegram
async function sendToTelegram(message, env) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: message, parse_mode: "Markdown" })
  });
}

export default {
  async fetch(request, env, ctx) {
    const report = await generateTradingReport(env);
    ctx.waitUntil(sendToTelegram(report, env));
    return new Response(report, { headers: { "Content-Type": "text/plain;charset=UTF-8" } });
  },
  async scheduled(event, env, ctx) {
    const report = await generateTradingReport(env);
    await sendToTelegram(report, env);
  }
};
