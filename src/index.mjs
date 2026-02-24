const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    return await this.runTask(env);
  },

  async scheduled(event, env) {
    await this.runTask(env);
  },

  async runTask(env) {
    try {
      // 1. 取得強勢股清單
      const stockList = ["TSM", "AAPL", "NVDA"]; // 先用固定 3 檔測試，確保 30 秒內跑完
      console.log(`✅ 成功取得測試股票: ${JSON.stringify(stockList)}`);

      let report = "🚀 **美股 AI 分析報告**\n\n";

      // 2. 逐檔分析
      for (let i = 0; i < stockList.length; i++) {
        const symbol = stockList[i];
        console.log(`正在分析第 ${i+1} 檔: ${symbol}...`);

        const prompt = `分析美股代號 ${symbol} 的近期趨勢，並給出操作建議。請用繁體中文回答，總字數 50 字以內。`;
        
        // 注意這裡的型號改回 1.5-flash，並確認 env 變數名稱
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

        try {
          const res = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });

          if (res.ok) {
            const data = await res.json();
            const analysis = data.candidates[0].content.parts[0].text;
            report += `📈 **${symbol}**\n${analysis}\n\n`;
            console.log(`✅ ${symbol} 分析完成`);
          } else {
            const errorText = await res.text();
            console.error(`❌ ${symbol} API 失敗:`, errorText);
            report += `❌ **${symbol}** 分析失敗\n\n`;
          }
        } catch (e) {
          console.error(`❌ 請求過程錯誤: ${e.message}`);
        }

        // 避免 API 頻繁限制，等待 2 秒
        await sleep(2000);
      }

      // 3. 發送到 Telegram
      console.log("正在發送至 Telegram...");
      const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TG_CHAT_ID,
          text: report,
          parse_mode: "Markdown"
        })
      });

      if (tgRes.ok) {
        console.log("✅ 報告已成功送達 Telegram！");
        return new Response("成功！請查看 Telegram。");
      } else {
        const tgErr = await tgRes.text();
        console.error("❌ Telegram 發送失敗:", tgErr);
        return new Response("Telegram 發送失敗: " + tgErr);
      }

    } catch (error) {
      console.error("❌ 系統崩潰:", error.stack);
      return new Response("系統錯誤: " + error.message);
    }
  }
};
