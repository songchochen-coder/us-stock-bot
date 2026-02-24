const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    console.log("🚀 機器人啟動...");
    try {
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告**\n\n";

      // 自動清理變數中的空格
      const apiKey = String(env.GEMINI_API_KEY || "").trim();
      const chatId = String(env.TG_CHAT_ID || "").trim();
      const tgToken = String(env.TG_BOT_TOKEN || "").trim();

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/3): ${symbol}...`);

        // ✅ 修正：使用 v1beta 搭配 gemini-1.5-flash (目前最穩定的組合)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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
            const errMsg = data.error ? data.error.message : "連線失敗";
            console.error(`❌ ${symbol} 失敗: ${errMsg}`);
            report += `❌ **${symbol}** 暫無資料 (${errMsg})\n\n`;
          }
        } catch (e) {
          report += `❌ **${symbol}** 系統連線異常\n\n`;
        }
        await sleep(2000); 
      }

      // 傳送到 Telegram
      const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report + "📝 *分析任務完成*",
          parse_mode: "Markdown"
        })
      });

      if (tgRes.ok) {
        console.log("🎉 報告已成功發送至 Telegram！");
        return new Response("OK! 檢查您的 Telegram。");
      } else {
        return new Response("Telegram 發送失敗", { status: 500 });
      }
    } catch (error) {
      return new Response("系統崩潰: " + error.message);
    }
  }
};
