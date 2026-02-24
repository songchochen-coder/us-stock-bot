// 輔助函數：延遲執行 (避免 API 頻率限制)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 輔助函數：呼叫 Gemini API
async function callGemini(prompt, systemInstruction, apiKey) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools: [{ googleSearch: {} }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
  };

  const res = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  try {
    return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  } catch (e) {
    console.error("Gemini JSON 解析失敗", text);
    return null;
  }
}

// 主程式：生成報告並寫入資料庫
async function generateTradingReport(env) {
  try {
    const isUS = true;
    const marketStr = isUS ? "US" : "TW";
    const today = new Date().toISOString().split('T')[0];

    // ==========================================
    // 階段一：從 TradingView 取得清單
    // ==========================================
    const tvUrl = "https://scanner.tradingview.com/america/scan";
    const tvPayload = {
      filter: [
        { left: "close", operation: "greater", right: 10 },
        { left: "Perf.1M", operation: "greater", right: 20 },
        { left: "market_cap_basic", operation: "greater", right: 5000000000 },
        { left: "average_volume_30d_calc", operation: "greater", right: 1500000 }
      ],
      options: { lang: "zh_TW" },
      markets: ["america"],
      symbols: { query: { types: ["stock"] }, tickers: [] },
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200"], 
      sort: { sortBy: "Perf.1M", sortOrder: "desc" },
      range: [0, 50] 
    };

    const tvResponse = await fetch(tvUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tvPayload)
    });

    if (!tvResponse.ok) return `⚠️ TradingView API 請求失敗`;
    const tvData = await tvResponse.json();
    let stocks = tvData.data || [];
    if (stocks.length === 0) return "目前沒有符合條件的美股標的。";

    // 限制分析數量，避免超時與 Rate Limit
    const totalFound = stocks.length;
    const processLimit = 12; 
    stocks = stocks.slice(0, processLimit); 

    let rawStockData = {};
    let analyzedStocks = []; 

    // ==========================================
    // 階段二：一檔一檔給 AI 分析，並存入 D1
    // ==========================================
    const singleStockSystemPrompt = "你是一位精準的美股分析師。請根據搜尋到的最新新聞與財報，判斷股票的題材板塊與上漲催化劑。嚴格回傳JSON格式，不要任何廢話。";

    for (const item of stocks) {
      const [name, description, close, sma20, sma50, sma200] = item.d;
      rawStockData[name] = { close, sma20, sma50, sma200 };

      const singlePrompt = `
      請搜尋並分析以下美股：${description} (代號: ${name})。
      目前收盤價: ${close}。
      
      請找出近期上漲的實質催化劑(Catalyst)，判斷其所屬的次產業板塊(Sector)，並給予評分。
      請直接回傳以下格式的 JSON：
      {
        "ticker": "${name}",
        "company": "${description}",
        "sector": "例如: AI伺服器 / 生技 / 網安",
        "catalyst": "簡述近期新聞、財報或實質利多，限制 50 字內",
        "hotness": 4, 
        "ai_stage": "Stage 2", 
        "strategy_tag": "拉回量縮承接" 
      }
      `;

      const aiResult = await callGemini(singlePrompt, singleStockSystemPrompt, env.GEMINI_API_KEY);
      
      if (aiResult) {
        analyzedStocks.push(aiResult);

        // 寫入 D1 資料庫
        if (env.DB) {
          try {
            await env.DB.prepare(`
              INSERT INTO DailyStockAnalysis (scan_date, market, ticker, company_name, close_price, sma_20, sma_50, sma_200, sector, ai_stage, strategy_tag) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              today, marketStr, aiResult.ticker, aiResult.company, 
              Number(close), Number(sma20), Number(sma50), Number(sma200),
              aiResult.sector, aiResult.ai_stage, aiResult.strategy_tag
            ).run();
          } catch (dbErr) {
            console.error(`寫入 ${name} 至 D1 失敗:`, dbErr);
          }
        }
      }

      // 暫停 4 秒，避免 Gemini API 限速
      await sleep(4000); 
    }

    if (analyzedStocks.length === 0) return "⚠️ 所有股票單檔分析皆失敗，請檢查 API 額度。";

    // ==========================================
    // 階段三：資料庫彙整，產生最終 Telegram 報告
    // ==========================================
    const summarySystemPrompt = "你是一位實戰派的美股趨勢交易員。請根據我提供的 JSON 陣列數據，撰寫精煉的盤後戰情報告。禁止任何開場白或結語。";
    
    const summaryPrompt = `
    以下是今日經過單檔深度分析後，從資料庫彙整出來的 ${analyzedStocks.length} 檔強勢股資料（JSON格式）：
    ${JSON.stringify(analyzedStocks, null, 2)}

    目前的客觀盤勢背景為：「主升段中後期，乖離過大」。
    請根據上述提供的結構化資料，【重新整理並歸納】成以下三大區塊（請嚴格遵守以下 Markdown 格式輸出，直接起手，勿說廢話）：

    【一】強勢板塊資金分佈統計
    1. [板塊名稱A]：共 X 檔
    ... (將上述資料依照 sector 分類統計，列出最多前五大)

    【二】美股強勢股實戰策略
    請將上述股票依「板塊」分組，並以戰情卡片呈現 (僅列出 hotness >= 3 的標的)：
    ### 📂 [板塊名稱]
    🔹 **[ticker] company** * 📰 **上漲催化劑**：[帶入資料庫中的 catalyst]
    * 🌡️ **熱度**：[將 hotness 轉為對應數量的 🔥]
    * 📈 **位階**：[帶入 ai_stage]
    * ⚔️ **策略**：**【[帶入 strategy_tag]】**

    【三】核心板塊領先股與資金外溢推演
    (依照你身為交易員的經驗，針對上述最大的板塊，給出 2 檔潛力外溢的觀察股與策略方向)
    `;

    const finalReportUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const finalRes = await fetch(finalReportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
        systemInstruction: { parts: [{ text: summarySystemPrompt }] }
      })
    });

    const finalData = await finalRes.json();
    const finalReport = finalData?.candidates?.[0]?.content?.parts?.[0]?.text || "報告生成失敗。";

    return `🔥【美股實戰交易決策：量價與趨勢風險評估】🔥\n✅ TV 總掃描共 ${totalFound} 檔，今日深度分析前 ${processLimit} 檔。\n\n====================\n${finalReport}`;

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
    body: JSON.stringify({ 
      chat_id: env.TG_CHAT_ID, 
      text: message 
    })
  });
}

// ==========================================
// 🚀 Cloudflare Worker 進入點 (ES Module 格式)
// ==========================================
export default {
  // 網頁手動觸發測試
  async fetch(request, env, ctx) {
    // 將耗時任務丟到背景執行，避免瀏覽器等待超時
    ctx.waitUntil((async () => {
      try {
        const report = await generateTradingReport(env);
        await sendToTelegram(report, env);
      } catch (err) {
        console.error("背景執行失敗:", err);
      }
    })());

    // 網頁立即回覆
    return new Response(
      "✅ 系統已收到指令！\n\n機器人正在背景逐檔分析美股新聞並寫入資料庫。\n由於加入了防限制(Rate Limit)機制，預計需耗時 1 分鐘左右，完成後會自動推播至您的 Telegram，請稍候並留意手機通知！", 
      { headers: { "Content-Type": "text/plain;charset=UTF-8" } }
    );
  },

  // 定時排程觸發 (Cron Triggers)
  async scheduled(event, env, ctx) {
    const report = await generateTradingReport(env);
    await sendToTelegram(report, env);
  }
};
