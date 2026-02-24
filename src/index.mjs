const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    console.log("🚀 機器人啟動...");
    try {
      // 1. 準備金鑰與 ID (增加強制修剪與錯誤檢查)
      const apiKey = String(env.GEMINI_API_KEY || "").trim();
      const chatId = String(env.TG_CHAT_ID || "").trim();
      const tgToken = String(env.TG_BOT_TOKEN || "").trim();

      if (!chatId) {
        console.error("❌ 錯誤：TG_CHAT_ID 是空的！請檢查 Cloudflare 變數設定。");
        return new Response("錯誤：TG_CHAT_ID 未設定");
      }

      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告**\n\n";

      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/3): ${symbol}...`);

        // ✅ 修正：改用 v1 穩定版 API 路徑，確保模型能被找到
        const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ parts: [{ text: `請簡短分析美股 ${symbol} 近期趨勢，50字內繁體中文。` }] }]
            })
          });

          const data = await res.json();
          if (res.ok && data.candidates) {
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
            console.log(`✅ ${symbol} 分析成功`);
          } else {
            const msg = data.error ? data.error.message : "模型路徑不支援";
            console.error(`❌ ${symbol} 失敗: ${msg}`);
            report += `❌ **${symbol}** 分析失敗 (${msg})\n\n`;
          }
        } catch (e) {
          report += `❌ **${symbol}** 系統異常\n\n`;
        }
        await sleep(2000); 
      }

      // 2. 發送報告至 Telegram
      const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: report + "📝 *分析完成*",
          parse_mode: "Markdown"
        })
      });

      if (tgRes.ok) {
        console.log("🎉 報告已成功發送至 Telegram！");
        return new Response("OK! 傳送成功。");
      } else {
        const tgErr = await tgRes.text();
        console.error(`❌ Telegram 發送失敗: ${tgErr}`);
        return new Response("Telegram 錯誤: " + tgErr);
      }
    } catch (error) {
      return new Response("崩潰: " + error.message);
    }
  }
};
