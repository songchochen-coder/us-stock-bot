const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    return await this.runTask(env);
  },

  async scheduled(event, env) {
    await this.runTask(env);
  },

  async runTask(env) {
    console.log("🚀 任務開始啟動...");
    try {
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股強勢股 AI 分析報告**\n\n";

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/3): ${symbol}...`);

        // ✅ 修正點：將 v1beta 改為 v1 穩定版網址
        const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

        const prompt = `請分析美股代號 ${symbol} 的近期趨勢，並給出操作建議。請用繁體中文回答，總字數限制在 50 字以內。`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });

          if (res.ok) {
            const data = await res.json();
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
            console.log(`✅ ${symbol} 分析成功`);
          } else {
            const errDetail = await res.text();
            console.error(`❌ ${symbol} 分析失敗: ${errDetail}`);
            report += `❌ **${symbol}** 分析失敗 (API 錯誤)\n\n`;
          }
        } catch (e) {
          console.error(`❌ ${symbol} 異常: ${e.message}`);
        }
        await sleep(2000);
      }

      report += "📝 *本報告由 AI 自動產生，僅供參考。*";

      const chatId = String(env.TG_CHAT_ID).trim();
      const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;

      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report,
          parse_mode: "Markdown"
        })
      });

      if (tgRes.ok) {
        console.log("🎉 報告已成功送達 Telegram！");
        return new Response("OK! 已發送。");
      } else {
        return new Response("Telegram 失敗");
      }
    } catch (error) {
      return new Response("系統崩潰: " + error.message);
    }
  }
};
