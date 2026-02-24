// 核心設定：直接定義正確的模型名稱，避開「2.5」這種不存在的型號
const MODEL_NAME = "gemini-1.5-flash"; // 或是改用 "gemini-2.0-flash"
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) { return await this.runTask(env); },
  async scheduled(event, env) { await this.runTask(env); },

  async runTask(env) {
    try {
      const stockList = ["TSM", "NVDA", "AAPL"];
      let report = "🚀 **美股 AI 分析報告**\n\n";

      for (const symbol of stockList) {
        // 標準 API 網址，確保路徑與型號名稱正確
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${env.GEMINI_API_KEY.trim()}`;

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
          // 這裡會抓出真正的 Google 錯誤原因
          report += `❌ **${symbol}** 錯誤: ${data.error ? data.error.message : "連線失敗"}\n\n`;
        }
        await sleep(2000); 
      }

      // 發送至 Telegram
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
      return new Response("崩潰: " + error.message);
    }
  }
};
