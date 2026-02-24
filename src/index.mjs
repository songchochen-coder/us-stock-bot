const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    return await this.runTask(env);
  },

  async scheduled(event, env) {
    await this.runTask(env);
  },

  async runTask(env) {
    console.log("🚀 任務啟動...");
    try {
      // 1. 基本股票清單 (測試用)
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告**\n\n";

      // 檢查金鑰並自動去空格
      const apiKey = String(env.GEMINI_API_KEY || "").trim();
      const chatId = String(env.TG_CHAT_ID || "").trim();

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/3): ${symbol}...`);

        // ✅ 終極修正：使用 v1beta 搭配 gemini-1.5-flash-latest
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ parts: [{ text: `分析 ${symbol} 近期趨勢，50字以內繁體中文。` }] }]
            })
          });

          const data = await res.json();
          if (res.ok && data.candidates) {
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
            console.log(`✅ ${symbol} 分析成功`);
          } else {
            const errMsg = data.error ? data.error.message : "未知錯誤";
            console.error(`❌ ${symbol} 失敗: ${errMsg}`);
            report += `❌ **${symbol}** 分析失敗 (${errMsg})\n\n`;
          }
        } catch (e) {
          report += `❌ **${symbol}** 系統錯誤\n\n`;
        }
        await sleep(2000);
      }

      // 2. 發送至 Telegram
      const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
      await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report + "\n📝 *自動分析完成*",
          parse_mode: "Markdown"
        })
      });

      console.log("🎉 報告已送出！");
      return new Response("OK! 已發送。");

    } catch (error) {
      return new Response("崩潰: " + error.message);
    }
  }
};
