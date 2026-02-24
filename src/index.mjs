const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    console.log("🚀 機器人啟動...");
    try {
      // 1. 測試股票清單
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告** (測試中)\n\n";

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析: ${symbol}...`);

        // ✅ 修正：使用目前最穩定的 v1beta + latest 標籤
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY.trim()}`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({ contents: [{ parts: [{ text: `分析 ${symbol} 近期趨勢，50字以內繁體中文。` }] }] })
          });

          const data = await res.json();
          if (res.ok && data.candidates) {
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
          } else {
            const errMsg = data.error ? data.error.message : "API 路徑錯誤";
            report += `❌ **${symbol}** 分析失敗 (${errMsg})\n\n`;
          }
        } catch (e) {
          report += `❌ **${symbol}** 連線錯誤\n\n`;
        }
        await sleep(2000); // 避開限制
      }

      // 2. 發送報告
      const chatId = String(env.TG_CHAT_ID).trim();
      console.log(`準備發送至 ChatID: ${chatId}`);
      
      const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report + "\n感謝您的耐心測試！",
          parse_mode: "Markdown"
        })
      });

      if (tgRes.ok) {
        return new Response("發送成功！請檢查 Telegram。");
      } else {
        const tgErr = await tgRes.text();
        return new Response("Telegram 錯誤: " + tgErr);
      }
    } catch (error) {
      return new Response("系統崩潰: " + error.message);
    }
  }
};
