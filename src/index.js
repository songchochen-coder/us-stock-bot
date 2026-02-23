// 【美股專屬】實戰交易決策與量化資料庫寫入機器人
async function generateTradingReport(env) {
  try {
    const isUS = true; // 🌟 切換為美股
    const marketStr = isUS ? "US" : "TW";
    const today = new Date().toISOString().split('T')[0];

    // 1. 呼叫 TradingView API (美股強勢股濾網：股價>10、市值>50億、均量>1500萬、月漲幅>20%)
    // 🌟 網址改為 america
    const tvUrl = "https://scanner.tradingview.com/america/scan";
    const tvPayload = {
      filter: [
        { left: "close", operation: "greater", right: 10 }, // 🌟 新增：股價大於 10 美元限制
        { left: "Perf.1M", operation: "greater", right: 20 },
        { left: "market_cap_basic", operation: "greater", right: 5000000000 },
        { left: "average_volume_30d_calc", operation: "greater", right: 1500000 }
      ],
      options: { lang: "zh_TW" }, // 保持繁體中文輸出
      markets: ["america"], // 🌟 市場改為 america
      symbols: { query: { types: ["stock"] }, tickers: [] },
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200"], 
      sort: { sortBy: "Perf.1M", sortOrder: "desc" },
      range: [0, 1500]
    };

    // 🛡️ 補回防擋 Headers，確保順利取得資料
    const tvResponse = await fetch(tvUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Origin": "https://www.tradingview.com",
        "Referer": "https://www.tradingview.com/"
      },
      body: JSON.stringify(tvPayload)
    });

    if (!tvResponse.ok) return `⚠️ TradingView 美股 API 請求失敗 (HTTP ${tvResponse.status})`;
    
    const tvData = await tvResponse.json();
    let stocks = tvData.data || [];

    if (stocks.length === 0) return "目前沒有符合條件（股價>10、月漲幅>20%、市值>50億、均量>150萬）的美股標的。";

    // 🛡️ 記錄總數量，並限制只交給 AI 前 20 檔最強勢股票，避免超時 (502 Error)
    const totalFound = stocks.length;
    stocks = stocks.slice(0, 20); 

    // 2. 格式化資料並保留原始數值供資料庫使用
    let rawStockData = {};
    let allStocksList = [];

    stocks.forEach(item => {
      const [name, description, close, sma20, sma50, sma200] = item.d;
      const c = close ? close.toFixed(2) : 0;
      const m20 = sma20 ? sma20.toFixed(2) : 0;
      const m50 = sma50 ? sma50.toFixed(2) : 0;
      const m200 = sma200 ? sma200.toFixed(2) : 0;

      rawStockData[name] = { close: c, sma20: m20, sma50: m50, sma200: m200 };
      allStocksList.push(`[${name}] ${description} (收盤:${c} | 20MA:${m20} | 50MA:${m50} | 200MA:${m200})`);
    });

    // 3. 準備 Gemini API 的呼叫設定 (🌟 已將提示詞內的台股替換為美股)
    const prompt = `
      以下為本週符合強勢濾網的【美股】名單與實際均線數據（共 ${stocks.length} 檔）：
      【${allStocksList.join("、")}】

      請以「頂級美股趨勢交易者」角度分析。目前的客觀盤勢背景為：「主升段中後期，乖離過大」。操作重心必須轉向「主流回測量縮」與「低位階補漲股」。嚴禁給出「可追價」建議。

      ⚠️ 全文輸出要求：說明請盡量簡短明白，直擊核心。嚴禁任何開場白、結語或多餘的客套介紹詞（例如「好的，為您分析...」），請直接起手輸出以下四大區塊。【⚠️ 絕對限制：報告中任何地方只要提及「股票名稱」，後方請務必加上「股票代碼」，例如：輝達 (NVDA)】。

      【一】強勢板塊資金分佈統計 (確認市場熱門族群)
      請先盤點上述清單中的所有股票，依照「題材板塊（次產業）」進行分類並統計檔數。請依照「股票數量由多至少」進行排序，【⚠️ 僅需列出前五大板塊即可】，藉此快速確認目前市場資金匯聚的重心。
      ⚠️ 格式範例：
      1. [板塊名稱A] (例如：AI 伺服器/散熱/矽光子)：共 X 檔
      2. [板塊名稱B]：共 Y 檔
      ...最多列到第 5 項。

      【二】美股強勢股實戰策略 (依題材分類與進場可行性)
      請將上述股票依「題材板塊」分類（標註：主流核心 / 次主流 / 非主流）。在板塊下依「進場可行性由高至低」排序。
      ⚠️ 執行要求 1：請務必搜尋近期相關新聞及產業報告，確認實際上漲催化劑（Catalyst），並評估漲勢延續的客觀條件。
      ⚠️ 執行要求 2 (過濾條件)：請嚴格篩選，本區塊【僅限分析熱度達 3 顆🔥 (含) 以上的股票】，低於 3 顆🔥的標的請直接忽略不出現在此區。
      ⚠️ 嚴禁使用 Markdown 表格，請使用以下戰情卡片格式：

      ### 📂 [板塊名稱] (標註：主流核心/次主流/非主流)
      🔹 **[代號] 公司名稱** (題材簡述)
      * 📰 **上漲催化劑**：[簡述近期新聞、營收、財報或產業報告所指出的實質利多原因]
      * 🔭 **延續性觀察**：[評估漲勢是否能持續，例如：是否具備 VCP 收斂型態、量價配合是否健康、是否有法人籌碼延續等]
      * 🌡️ **熱度**：[3~5顆🔥] ｜ 資金集中度：[高/中/低]
      * 📈 **位階**：Stage [1~4] ｜ 加速：[是/否] ｜ 乖離風險：[高/中/低]
      * ⚔️ **策略**：**【建議標籤】** (⚠️ 限填: 拉回量縮承接 / 突破買進 / 僅觀察 / 高檔風險) - [請參考客觀數值與型態給出具體進場或防守條件]

      【三】核心板塊領先股與資金外溢推演
      此部分請分為「最熱門前兩大板塊」與「潛力外溢板塊」兩個視角進行分析：

      (A) 最熱門前兩大板塊 (挖掘漏網之魚)
      針對【一】統計出檔數最多的「前兩大板塊」，各挑選出 2 檔【未出現在上述強勢股清單中，但具備領先或補漲潛力】的同族群代表股進行分析。
      🔹 **[熱門板塊名稱]** (族群強弱邏輯：說明該板塊目前的整體資金結構與市場地位)
      * 🎯 **其他領先/補漲觀察股**：[列舉 2 檔美股代號與名稱，並簡述其技術面或籌碼面優勢]
      * ⚔️ **策略方向**：[給出針對該族群的整體篩選或進場條件]

      (B) 潛力外溢板塊推演 (尋找下一個風口)
      依據目前的熱門資金流向與產業邏輯，推演 2 個資金最可能「外溢/輪動」過去的次產業。
      🔹 **[外溢板塊名稱]** (外溢資金邏輯：說明為何研判資金即將/正在流向這裡)
      * 🌡️ **板塊熱度預期**：[1~5顆🔥] ｜ 資金卡位機率：[高/中/低]
      * 🎯 **指標觀察股**：[列舉 2 檔該外溢板塊的美股代號與名稱]
      * ⚔️ **策略方向**：[給出篩選條件，例如：等待底部出量、觀察指標股是否率先突破 Stage 2 等]

      【四】資料庫寫入專用 JSON (⚠️ 系統核心，請務必精準輸出)
      為了將分析結果寫入量化資料庫，請在報告最下方，輸出一整段純 JSON 陣列，包含名單中【所有股票】的判定結果。
      請嚴格包裝在 \`\`\`json 和 \`\`\` 之間，格式如下：
      \`\`\`json
      [
        { "ticker": "NVDA", "company": "輝達", "sector": "AI晶片", "ai_stage": "Stage 2", "strategy": "高檔風險" }
      ]
      \`\`\`
    `;

    const geminiPayload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: {
        parts: [{ text: "你是一位實戰派的美股趨勢交易員。極度厭惡追高。操作紀律是：只做核心主流的回測量縮，並將重倉放在位階低的潛力族群。說明務必簡短明白，字字珠璣，嚴禁任何開場白、結語或多餘的介紹詞。請嚴格依照要求輸出 Markdown 與 JSON 格式。" }]
      },
      tools: [{ googleSearch: {} }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.2
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
      ]
    };
    
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    
    const aiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });

    if (!aiResponse.ok) {
        const errText = await aiResponse.text();
        console.error("Gemini API 失敗:", errText);
        return `⚠️ AI 分析失敗 (HTTP ${aiResponse.status})`;
    }

    const aiData = await aiResponse.json();
    const rawAnalysis = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawAnalysis) {
      return "⚠️ AI 回應內容異常！請檢查環境變數是否設定正確。原始錯誤資料如下：\n" + JSON.stringify(aiData, null, 2);
    }

    // 4. 攔截 JSON 資料並清理 Telegram 推播畫面
    let reportForTelegram = rawAnalysis;
    let dbJsonArray = [];

    const jsonMatch = rawAnalysis.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        dbJsonArray = JSON.parse(jsonMatch[1]);
        reportForTelegram = rawAnalysis
          .replace(/```json\n[\s\S]*?\n```/, '')
          .replace(/【四】資料庫寫入專用 JSON[\s\S]*/, '') 
          .trim();
      } catch(e) { 
        console.error("JSON 解析失敗", e); 
      }
    }

    // 5. 將資料寫入 D1 資料庫 (終極防呆版)
    if (env.DB && dbJsonArray.length > 0) {
      const stmt = env.DB.prepare(`
        INSERT INTO DailyStockAnalysis (scan_date, market, ticker, company_name, close_price, sma_20, sma_50, sma_200, sector, ai_stage, strategy_tag) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      let batchStmts = [];
      for (let item of dbJsonArray) {
        const t = item.ticker || item.symbol || "UNKNOWN";
        const tvData = rawStockData[t] || { close: 0, sma20: 0, sma50: 0, sma200: 0 };
        
        batchStmts.push(stmt.bind(
          today, 
          marketStr, 
          t, 
          item.company || item.company_name || "UNKNOWN", 
          Number(tvData.close) || 0, 
          Number(tvData.sma20) || 0, 
          Number(tvData.sma50) || 0, 
          Number(tvData.sma200) || 0, 
          item.sector || "N/A", 
          item.ai_stage || item.stage || "N/A", 
          item.strategy || item.strategy_tag || "N/A"
        ));
      }
      
      try {
        await env.DB.batch(batchStmts);
      } catch (dbError) {
        console.error("D1 美股寫入失敗:", dbError);
      }
    }

    return `🔥【美股實戰交易決策：量價與趨勢風險評估】🔥\n✅ 本日符合條件共 ${totalFound} 檔，為求精準僅分析最強前 20 檔。\n\n====================\n${reportForTelegram}`;

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

export default {
  // 網頁手動觸發測試
  async fetch(request, env, ctx) {
    const report = await generateTradingReport(env);
    ctx.waitUntil(sendToTelegram(report, env));
    return new Response("✅ 執行完畢，請至 Telegram 查看結果！\n\n" + report, { 
      headers: { "Content-Type": "text/plain;charset=UTF-8" } 
    });
  },

  // 定時排程觸發 (Cron Triggers)
  async scheduled(event, env, ctx) {
    const report = await generateTradingReport(env);
    await sendToTelegram(report, env);
  }
};
