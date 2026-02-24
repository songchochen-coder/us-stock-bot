const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    try {
      const stockList = ["TSM", "NVDA", "AAPL"]; // 測試用
      let report = "🚀 **美股 AI 分析報告**\n\n";

      // 1. 確保金鑰乾淨
      const apiKey = String(env.GEMINI_API_KEY || "").trim();

      for (const symbol of stockList) {
        // 2. 使用最一般的 v1beta 標準網址
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `分析 ${symbol} 近期趨勢，50字以內繁體中文。` }] }]
          })
        });

        const data = await res.json();
        
        if (res.ok && data.candidates) {
          const analysis = data.candidates[0].content.parts[0].text;
          report += `📈 **${symbol}**\n${analysis.trim()}\n\n`;
        } else {
          // 如果還是失敗，讓訊息直接告訴我們 Google 說了什麼
          const errorMsg = data.error ? data.error.message : "未知錯誤";
          report += `❌ **${symbol}** 分析失敗 (${errorMsg})\n\n`;
        }
        await sleep(2000); 
      }

      // 3. 發送至 Telegram (這部分你已經通了，照舊即可)
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(env.TG_CHAT_ID).trim(),
          text: report + "📝 *自動分析完成*",
          parse_mode: "Markdown"
        })
      });

      return new Response("OK");
    } catch (error) {
      return new Response("系統崩潰: " + error.message);
    }
  }
};
