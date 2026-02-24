async analyzeWithGemini(env, stock) {
    // 修正點：切換到 v1 穩定版端點
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    
    const prompt = `分析美股代號 ${stock.ticker}。目前的收盤價為 ${stock.close_price}。
    請搜尋該公司近期催化劑與板塊。僅回傳 JSON 格式：
    {"sector": "板塊", "catalyst": "原因", "stage": "1-4", "heat": 5, "strategy": "標籤"}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.1,
          response_mime_type: "application/json" 
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      // 如果 v1 還是報 404，請確認 GEMINI_API_KEY 是否有效
      throw new Error(`Gemini API 失敗 (${response.status}): ${err}`);
    }

    const data = await response.json();
    const rawText = data.candidates[0].content.parts[0].text;
    
    // 取出 JSON 部分
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("無法解析回傳的 JSON");
    
    return JSON.parse(jsonMatch[0]);
  },
