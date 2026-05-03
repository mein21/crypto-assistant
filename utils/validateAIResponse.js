// utils/validateAIResponse.js
// Port of Python ai_analysis.validate_response to JavaScript
// Returns an object with validation info for the AI text response

const garbagePatterns = ["$Y", "$X", "INSERT", "TITLE", "placeholder", "XXX", "XXXX"];

function extractNumber(str) {
  const num = parseFloat(str.replace(/,/g, "."));
  return isNaN(num) ? null : num;
}

function validateAIResponse(text, currentPrice) {
  const result = {
    valid: false,
    recommendation: null,
    entry_price: null,
    take_profit: null,
    stop_loss: null,
    confidence: null,
    reason: null,
    raw_response: text,
  };

  if (!text || !currentPrice) return result;

  // check garbage placeholders
  for (const pat of garbagePatterns) {
    if (text.includes(pat)) {
      console.warn(`Found garbage pattern: ${pat}`);
      return result;
    }
  }

  // recommendation LONG/SHORT/HET
  const recMatch = /(LONG|SHORT|HET|SELL|BUY)/i.exec(text);
  if (recMatch) {
    const rec = recMatch[1].toUpperCase();
    if (rec === "LONG" || rec === "BUY") result.recommendation = "LONG";
    else if (rec === "SHORT" || rec === "SELL") result.recommendation = "SHORT";
    else result.recommendation = "HET";
  // если не найдено, считаем HET (нет рекомендации)
  }

  // entry price
  const entryMatch = /(?:входа|entry|цена|price)[:\s]*\$?([\d\s]+(?:[.,]\d+)?)/i.exec(text);
  if (entryMatch) result.entry_price = extractNumber(entryMatch[1]);

  // take profit
  const tpMatch = /(?:Take\s*Profit|TP|тейк[\s-]?профит)[:\s]*\$?([\d\s]+(?:[.,]\d+)?)/i.exec(text);
  if (tpMatch) result.take_profit = extractNumber(tpMatch[1]);

  // stop loss
  const slMatch = /(?:Stop\s*Loss|SL|стоп[\s-]?лосс)[:\s]*\$?([\d\s]+(?:[.,]\d+)?)/i.exec(text);
  if (slMatch) result.stop_loss = extractNumber(slMatch[1]);

  // confidence
  const confMatch = /(?:уверенность|confidence)[:\s]*(\d+)/i.exec(text);
  if (confMatch) {
    let c = parseInt(confMatch[1], 10);
    if (c > 10) c = Math.floor(c / 10);
    // Сохраняем оригинальное значение (может быть от 0 до 100)
  result.rawConfidence = c;
  // Приводим к шкале 1‑10 для UI, но оставляем дробную часть
  result.confidence = Math.min(Math.max(c / 10, 0.1), 10);
  }

  // reason
  const reasonMatch = /(?:причина|обоснование|reason)[:\s]*([\s\S]{10,300})/i.exec(text);
  if (reasonMatch) {
    let r = reasonMatch[1].trim().split('\n')[0].trim();
    if (r.length > 200) r = r.slice(0, 197) + "...";
    result.reason = r;
  }

  // negative checks
  if (result.entry_price && result.entry_price <= 0) result.entry_price = null;
  if (result.take_profit && result.take_profit <= 0) result.take_profit = null;
  if (result.stop_loss && result.stop_loss <= 0) result.stop_loss = null;

  // realistic price range ±30%
  if (result.entry_price) {
    if (currentPrice * 0.7 < result.entry_price && result.entry_price < currentPrice * 1.3) {
      result.valid = true;
    }
  } else if (result.take_profit || result.stop_loss) {
    result.entry_price = currentPrice;
    result.valid = true;
  }

  return result;
}

module.exports = { validateAIResponse };
