(function() {
  window.__API_LOGS = [];
  const originalFetch = window.fetch;
  
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
    const method = (args[1] && args[1].method) || 'GET';
    const isApi = url.includes('/api/');
    
    if (isApi) {
      const logEntry = {
        time: new Date().toLocaleTimeString(),
        url,
        method,
        status: 'pending',
        durationMs: 0
      };
      window.__API_LOGS.push(logEntry);
      const start = performance.now();
      
      try {
        const response = await originalFetch.apply(this, args);
        logEntry.status = response.status;
        logEntry.durationMs = Math.round(performance.now() - start);
        return response;
      } catch (err) {
        logEntry.status = 'error';
        logEntry.durationMs = Math.round(performance.now() - start);
        logEntry.error = err.message;
        throw err;
      }
    }
    
    return originalFetch.apply(this, args);
  };

  window.copyApiLogs = function() {
    const summary = {};
    window.__API_LOGS.forEach(log => {
      // Group by URL (including action param if present to be more specific)
      let path = log.url.split('?')[0];
      if (log.url.includes('?action=')) {
          const action = new URL(log.url.startsWith('http') ? log.url : window.location.origin + log.url).searchParams.get('action');
          if (action) path += `?action=${action}`;
      }
      if (!summary[path]) summary[path] = 0;
      summary[path]++;
    });

    const output = {
      totalApiCallsSinceLogin: window.__API_LOGS.length,
      summary,
      logs: window.__API_LOGS
    };

    const text = JSON.stringify(output, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      alert(`Copied ${window.__API_LOGS.length} API calls to clipboard!\n\nSummary:\n${Object.entries(summary).map(([k,v]) => `${k}: ${v} calls`).join('\n')}`);
    }).catch(err => {
      alert("Failed to copy. See console for logs.");
      console.log(text);
    });
  };

  // Inject a floating button to copy logs
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.createElement("button");
    btn.innerHTML = "📋 Copy API Logs";
    btn.style.position = "fixed";
    btn.style.bottom = "20px";
    btn.style.left = "20px";
    btn.style.zIndex = "999999";
    btn.style.padding = "8px 12px";
    btn.style.background = "#ba1a1a"; // Red to stand out
    btn.style.color = "#fff";
    btn.style.border = "1px solid #93000a";
    btn.style.borderRadius = "8px";
    btn.style.fontSize = "12px";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
    btn.onclick = window.copyApiLogs;
    document.body.appendChild(btn);
  });
})();
