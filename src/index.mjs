/**
 * 美股強勢股 AI 分析機器人
 * 修復版：包含 sleep 定義、修正 Gemini 1.5 URL、加強變數抓取
 */

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  // 當您透過網址訪問時觸發
  async fetch(request, env) {
    return await this.runTask(env);
  },

  // 當排程時間到時自動觸發
  async scheduled(event, env) {
    await this.runTask(env);
  },

  async runTask(env) {
    console.log("🚀 任務開始啟動...");
    
    // 檢查變數是否讀取成功 (會在 Cloudflare 日誌顯示)
    console.log("Debug - TG_CHAT_ID 是否存在:", !!env.TG_CHAT_ID);
    console.log("Debug - TG_BOT_TOKEN 是否存在:", !!env.TG_BOT_TOKEN);
    console.log("Debug - GEMINI_API_KEY 是否存在:", !!env.GEMINI_API_KEY);

    try {
      // 1. 設定要分析的股票 (測試期固定 3 檔，確保不超過 30 秒限制)
      const stockList = ["TSM", "NVDA", "AAPL"];
      console.log(`✅ 預備分析清單: ${JSON.stringify(stockList)}`);

      let report = "🚀 **美股強勢股 AI 分析報告**\n\n";

      // 2. 逐檔向 Gemini 請求分析
      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析 (${i + 1}/${stockList.length}): ${symbol}...`);

        // 修正後的 Gemini v1beta 網址
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

        const prompt = `請分析美股代號 ${symbol} 的近期趨勢，並給出操作建議。請用繁體中文回答，總字數限制在 50 字以內。`;

        try {
          const res = await fetch(geminiUrl, {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
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
          console.error(`❌ ${symbol} 請求過程發生異常: ${e.message}`);
        }

        // 每次 API 呼叫後暫停 2 秒，避免頻繁請求錯誤
        await sleep(2000);
      }

      report += "📝 *本報告由 AI 自動產生，僅供參考。*";

      // 3. 發送到 Telegram
      console.log("正在準備發送報告至 Telegram...");
      
      // 確保 ID 為字串且移除可能的空格
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
        return new Response("OK! 報告已發送至 Telegram。", { status: 200 });
      } else {
        const tgErrText = await tgRes.text();
        console.error(`❌ Telegram 發送失敗: ${tgErrText}`);
        return new Response(`Telegram 錯誤: ${tgErrText}`, { status: 400 });
      }

    } catch (error) {
      console.error(`❌ 系統運作崩潰: ${error.message}`);
      return new Response(`系統崩潰: ${error.message}`, { status: 500 });
    }
  }
};
