const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    console.log("🚀 機器人啟動...");
    try {
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告**\n\n";

      const apiKey = String(env.GEMINI_API_KEY || "").trim();
      const chatId = String(env.TG_CHAT_ID || "").trim();
      const tgToken = String(env.TG_BOT_TOKEN || "").trim();

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/3): ${symbol}...`);

        // ✅ 修正：使用 v1beta 搭配最新的 -latest 標籤
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ parts: [{ text: `請分析美股代號 ${symbol} 的近期趨勢，並給出操作建議。請用繁體中文回答，50字以內。` }] }]
            })
          });

          const data = await res.json();
          if (res.ok && data.candidates) {
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
            console.log(`✅ ${symbol} 分析成功`);
          } else {
            const msg = data.error ? data.error.message : "API 拒絕連線";
            console.error(`❌ ${symbol} 失敗: ${msg}`);
            report += `❌ **${symbol}** 分析失敗 (${msg})\n\n`;
          }
        } catch (e) {
          report += `❌ **${symbol}** 系統異常\n\n`;
        }
        await sleep(2000); 
      }

      // 發送至 Telegram
      const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report + "📝 *本次分析完成*",
          parse_mode: "Markdown"
        })
      });

      console.log("🎉 報告已成功發送至 Telegram！");
      return new Response("OK! 檢查您的 Telegram。");

    } catch (error) {
      return new Response("系統崩潰: " + error.message);
    }
  }
};
