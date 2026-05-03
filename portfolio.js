// portfolio.js – загружает портфолио и выводит его в таблицу
(async () => {
  const loader   = document.getElementById('loader');
  const table    = document.getElementById('portfolioTable');
  const tbody    = document.getElementById('portfolioBody');
  const errorDiv = document.getElementById('errorMsg');

  try {
    const resp = await fetch('/api/portfolio');
    const data = await resp.json();

    if (!data.success) {
      throw new Error(data.error || 'Не удалось получить портфолио');
    }

    const pairs = data.pairs;
    if (!pairs || pairs.length === 0) {
      throw new Error('Портфолио пустое');
    }

    pairs.forEach((t, i) => {
      const tr = document.createElement('tr');
      const cells = [
        i + 1,
        t.pair || '--',
        t.direction || '--',
        (t.entryPrice !== undefined && t.entryPrice !== null)
          ? `$${Number(t.entryPrice).toLocaleString()}`
          : '--',
        (t.tp !== undefined && t.tp !== null)
          ? `$${Number(t.tp).toLocaleString()}`
          : '',
        (t.sl !== undefined && t.sl !== null)
          ? `$${Number(t.sl).toLocaleString()}`
          : '',
        // показываем оригинальную уверенность, если есть, иначе нормализованную
        t.rawConfidence !== undefined ? `${t.rawConfidence}/10` : (t.confidence ? `${t.confidence}/10` : '--'),
        t.reason || '--'
      ];
      cells.forEach(c => {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    loader.style.display = 'none';
    table.style.display  = 'table';
  } catch (e) {
    loader.style.display = 'none';
    errorDiv.textContent = '❌ ' + e.message;
    errorDiv.className   = 'comments show error';
    console.error(e);
  }
})();