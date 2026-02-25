// 1. 呼叫 TradingView API (美股強勢股濾網)
    const tvUrl = "https://scanner.tradingview.com/america/scan";
    const tvPayload = {
      filter: [
        { left: "close", operation: "greater", right: 10 }, 
        { left: "Perf.1M", operation: "greater", right: 20 },
        { left: "market_cap_basic", operation: "greater", right: 300000000 }, // 3億美元以上
        { left: "average_volume_30d_calc", operation: "greater", right: 1500000 }
      ],
      options: { lang: "zh_TW" },
      markets: ["america"],
      symbols: { query: { types: ["stock"] }, tickers: [] },
      // 🌟 核心升級 1：多跟 TradingView 要一個 "sector" (板塊/產業) 的資料
      columns: ["name", "description", "close", "SMA20", "SMA50", "SMA200", "sector"], 
      sort: { sortBy: "Perf.1M", sortOrder: "desc" },
      range: [0, 1500]
    };

    const tvResponse = await fetch(tvUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": "https://www.tradingview.com",
        "Referer": "https://www.tradingview.com/"
      },
      body: JSON.stringify(tvPayload)
    });

    if (!tvResponse.ok) return `⚠️ TradingView 美股 API 請求失敗 (HTTP ${tvResponse.status})`;
    
    const tvData = await tvResponse.json();
    let stocks = tvData.data || [];

    if (stocks.length === 0) return "目前沒有符合條件的美股標的。";
    const totalFound = stocks.length;

    // 🌟 核心升級 2：用 JS 自動統計全市場 (例如 52 檔) 的板塊熱度，不讓 AI 算數學
    let sectorCounts = {};
    stocks.forEach(item => {
      // 陣列第 6 個元素就是我們剛剛加的 sector
      const sector = item.d[6] || "其他未分類"; 
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    });

    // 將統計結果由大到小排序，並轉成文字格式
    const sortedSectors = Object.entries(sectorCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([sector, count], index) => `${index + 1}. [${sector}]：共 ${count} 檔`);
    
    const sectorStatsString = sortedSectors.join("\n");

    // 🌟 核心升級 3：統計完大盤後，嚴格擷取最強的「前 10 檔」給 AI 分析
    const top10Stocks = stocks.slice(0, 10); 

    let rawStockData = {};
    let allStocksList = [];

    top10Stocks.forEach(item => {
      // 多接一個 sector 變數
      const [name, description, close, sma20, sma50, sma200, sector] = item.d;
      const c = close ? close.toFixed(2) : 0;
      const m20 = sma20 ? sma20.toFixed(2) : 0;
      const m50 = sma50 ? sma50.toFixed(2) : 0;
      const m200 = sma200 ? sma200.toFixed(2) : 0;

      rawStockData[name] = { close: c, sma20: m20, sma50: m50, sma200: m200 };
      allStocksList.push(`[${name}] ${description} (板塊:${sector} | 收盤:${c} | 20MA:${m20})`);
    });

    // 3. 準備 Gemini API 的呼叫設定 (Prompt 大幅瘦身與優化)
    const prompt = `
      您好，我是量化交易系統。本日全市場共有 ${totalFound} 檔美股符合強勢飆股濾網。
      
      【全市場資金板塊熱度統計】(系統已自動結算)：
      ${sectorStatsString}

      請根據上述客觀的資金板塊分佈背景，針對以下精選的【前 10 檔最強勢標的】進行深度實戰分析：
      【${allStocksList.join("、")}】

      請以「頂級美股趨勢交易者」角度分析。操作重心必須轉向「主流回測量縮」與「低位階補漲股」。嚴禁給出「可追價」建議。
      ⚠️ 絕對限制：報告中任何地方只要提及「股票名稱」，後方請務必加上「股票代碼」，例如：輝達 (NVDA)。說明請盡量簡短明白，嚴禁廢話開場白。

      請直接輸出以下三大區塊：

      【一】美股強勢股實戰策略 (依題材分類與進場可行性)
      請將上述 10 檔股票依「題材板塊」分類（標註：主流核心 / 次主流 / 非主流）。
      ⚠️ 執行要求 1：請務必搜尋近期相關新聞及產業報告，確認實際上漲催化劑（Catalyst）。
      ⚠️ 執行要求 2：【僅限分析熱度達 3 顆🔥 (含) 以上的股票】，低於 3 顆🔥請直接忽略。
      ⚠️ 請使用以下戰情卡片格式：
      ### 📂 [板塊名稱] 
      🔹 **[代號] 公司名稱** (題材簡述)
      * 📰 **上漲催化劑**：[簡述近期實質利多原因]
      * 🔭 **延續性觀察**：[評估漲勢是否能持續，是否有法人籌碼等]
      * 🌡️ **熱度**：[3~5顆🔥] ｜ 資金集中度：[高/中/低]
      * 📈 **位階**：Stage [1~4] ｜ 加速：[是/否] ｜ 乖離風險：[高/中/低]
      * ⚔️ **策略**：**【建議標籤】** - [給出具體進場或防守條件]

      【二】潛力外溢板塊推演 (尋找下一個風口)
      依據系統提供的【全市場資金板塊熱度統計】，推演 2 個資金最可能「外溢/輪動」過去的次產業，並各給出 2 檔觀察標的 (需附代碼)。

      【三】資料庫寫入專用 JSON (⚠️ 系統核心，請務必精準輸出)
      將分析的股票結果包裝在 \`\`\`json 和 \`\`\` 之間，格式如下：
      \`\`\`json
      [
        { "ticker": "NVDA", "company": "輝達", "sector": "電子技術", "ai_stage": "Stage 2", "strategy": "高檔風險" }
      ]
      \`\`\`
    `;

    // ... 後續呼叫 Gemini 與寫入 D1 的程式碼維持您原本的即可 ...
