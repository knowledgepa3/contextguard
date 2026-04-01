/**
 * Dashboard HTML Template
 *
 * Single-file React dashboard with Tailwind from CDN.
 * No build step needed — serves directly from the Node server.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ContextGuard Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            cg: { bg: '#0a0c10', card: '#161b22', border: '#30363d', accent: '#58a6ff' }
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-glow { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }
    .pulse-glow { animation: pulse-glow 2s infinite }
    .grade-a { color: #3fb950 } .grade-b { color: #3fb950 }
    .grade-c { color: #d29922 } .grade-d { color: #f85149 } .grade-f { color: #f85149 }
  </style>
</head>
<body class="bg-cg-bg text-gray-200 min-h-screen font-mono">
  <div id="app"></div>

  <script>
    // Reactive state
    let state = null;

    // SSE connection
    const evtSource = new EventSource('/events');
    evtSource.onmessage = (e) => {
      state = JSON.parse(e.data);
      render();
    };

    function pct(n) { return Math.round(n * 100) }
    function fmt(n) { return n.toLocaleString() }
    function gradeClass(g) { return 'grade-' + g.toLowerCase() }

    function barColor(ratio) {
      if (ratio > 0.9) return 'bg-red-500';
      if (ratio > 0.7) return 'bg-yellow-500';
      return 'bg-green-500';
    }

    function render() {
      const app = document.getElementById('app');

      if (!state) {
        app.innerHTML = \`
          <div class="flex items-center justify-center h-screen">
            <div class="text-center">
              <div class="text-4xl mb-4 pulse-glow text-cg-accent">&#x25C9;</div>
              <h1 class="text-xl font-bold mb-2">ContextGuard Dashboard</h1>
              <p class="text-gray-500">Waiting for inspection data...</p>
              <p class="text-gray-600 text-sm mt-4">Send data to POST /update</p>
            </div>
          </div>
        \`;
        return;
      }

      const { budget, health } = state;

      app.innerHTML = \`
        <div class="max-w-6xl mx-auto p-6">
          <!-- Header -->
          <div class="flex items-center justify-between mb-8">
            <div>
              <h1 class="text-2xl font-bold text-cg-accent">ContextGuard</h1>
              <p class="text-gray-500 text-sm">Context Budget Dashboard</p>
            </div>
            <div class="text-right">
              <div class="text-sm text-gray-500">Last updated</div>
              <div class="text-sm">\${new Date(state.updatedAt).toLocaleTimeString()}</div>
            </div>
          </div>

          <!-- Top Stats -->
          <div class="grid grid-cols-4 gap-4 mb-8">
            <div class="bg-cg-card border border-cg-border rounded-lg p-4">
              <div class="text-gray-500 text-xs uppercase mb-1">Health</div>
              <div class="text-4xl font-bold \${gradeClass(health.grade)}">\${health.grade}</div>
              <div class="text-gray-400 text-sm">\${health.score}/100</div>
            </div>
            <div class="bg-cg-card border border-cg-border rounded-lg p-4">
              <div class="text-gray-500 text-xs uppercase mb-1">Utilization</div>
              <div class="text-4xl font-bold">\${pct(budget.utilization)}%</div>
              <div class="text-gray-400 text-sm">\${fmt(budget.totalTokensUsed)} / \${fmt(budget.totalTokensAvailable)}</div>
            </div>
            <div class="bg-cg-card border border-cg-border rounded-lg p-4">
              <div class="text-gray-500 text-xs uppercase mb-1">Items</div>
              <div class="text-4xl font-bold">\${state.itemCount || budget.categories.reduce((s,c) => s + c.itemCount, 0)}</div>
              <div class="text-gray-400 text-sm">in context</div>
            </div>
            <div class="bg-cg-card border border-cg-border rounded-lg p-4">
              <div class="text-gray-500 text-xs uppercase mb-1">Status</div>
              <div class="text-4xl font-bold \${budget.hasOverage ? 'text-red-500' : budget.hasWarnings ? 'text-yellow-500' : 'text-green-500'}">\${budget.hasOverage ? 'OVER' : budget.hasWarnings ? 'WARN' : 'OK'}</div>
              <div class="text-gray-400 text-sm">\${budget.hasOverage ? 'Budget exceeded' : budget.hasWarnings ? 'Near limit' : 'All clear'}</div>
            </div>
          </div>

          <!-- Main Grid -->
          <div class="grid grid-cols-2 gap-6">
            <!-- Category Breakdown -->
            <div class="bg-cg-card border border-cg-border rounded-lg p-6">
              <h2 class="text-lg font-bold mb-4">Category Breakdown</h2>
              <div class="space-y-3">
                \${budget.categories.filter(c => c.tokensAllocated > 0).map(cat => \`
                  <div>
                    <div class="flex justify-between text-sm mb-1">
                      <span class="font-medium">\${cat.category}</span>
                      <span class="text-gray-400">
                        \${fmt(cat.tokensUsed)} / \${fmt(cat.tokensAllocated)}
                        (\${pct(cat.percentage)}%)
                        \${cat.overBudget ? '<span class="text-red-500 font-bold">OVER</span>' : ''}
                        \${cat.warning && !cat.overBudget ? '<span class="text-yellow-500">WARN</span>' : ''}
                      </span>
                    </div>
                    <div class="w-full bg-gray-800 rounded-full h-2">
                      <div class="\${barColor(cat.percentage)} rounded-full h-2 transition-all duration-500"
                           style="width: \${Math.min(pct(cat.percentage), 100)}%"></div>
                    </div>
                    <div class="text-xs text-gray-500 mt-1">\${cat.itemCount} items</div>
                  </div>
                \`).join('')}
              </div>
            </div>

            <!-- Health Dimensions -->
            <div class="bg-cg-card border border-cg-border rounded-lg p-6">
              <h2 class="text-lg font-bold mb-4">Health Dimensions</h2>
              <div class="space-y-4">
                \${health.dimensions.map(dim => \`
                  <div>
                    <div class="flex justify-between text-sm mb-1">
                      <span class="font-medium">\${dim.name}</span>
                      <span class="text-gray-400">\${Math.round(dim.score * 100)}% (weight: \${Math.round(dim.weight * 100)}%)</span>
                    </div>
                    <div class="w-full bg-gray-800 rounded-full h-2">
                      <div class="\${barColor(1 - dim.score)} rounded-full h-2 transition-all duration-500"
                           style="width: \${Math.round(dim.score * 100)}%"></div>
                    </div>
                    <div class="text-xs text-gray-500 mt-1">\${dim.detail}</div>
                  </div>
                \`).join('')}
              </div>
            </div>
          </div>

          <!-- Recommendations -->
          \${health.recommendations.length > 0 ? \`
            <div class="bg-cg-card border border-cg-border rounded-lg p-6 mt-6">
              <h2 class="text-lg font-bold mb-3">Recommendations</h2>
              <ul class="space-y-2">
                \${health.recommendations.map(rec => \`
                  <li class="flex items-start gap-2">
                    <span class="text-yellow-500 mt-0.5">&#x25B6;</span>
                    <span class="text-gray-300">\${rec}</span>
                  </li>
                \`).join('')}
              </ul>
            </div>
          \` : ''}

          <!-- Footer -->
          <div class="text-center text-gray-600 text-xs mt-8 pb-4">
            ContextGuard by ACE &mdash; Context is a budget, not a dump.
          </div>
        </div>
      \`;
    }

    // Initial render
    render();
  </script>
</body>
</html>`;
