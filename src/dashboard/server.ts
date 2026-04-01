/**
 * ContextGuard Dashboard Server
 *
 * Lightweight Express server that serves a real-time context budget
 * dashboard. Receives inspection data via POST and displays it.
 *
 * Usage:
 *   contextguard dashboard              # Start on port 4200
 *   contextguard dashboard --port 8080  # Custom port
 */

import { createServer } from 'node:http';
import { DASHBOARD_HTML } from './template.js';

export interface DashboardState {
  budget: {
    totalTokensUsed: number;
    totalTokensAvailable: number;
    utilization: number;
    categories: Array<{
      category: string;
      tokensUsed: number;
      tokensAllocated: number;
      percentage: number;
      itemCount: number;
      overBudget: boolean;
      warning: boolean;
    }>;
    hasOverage: boolean;
    hasWarnings: boolean;
  };
  health: {
    score: number;
    grade: string;
    dimensions: Array<{
      name: string;
      score: number;
      weight: number;
      detail: string;
    }>;
    recommendations: string[];
  };
  itemCount: number;
  updatedAt: number;
}

let currentState: DashboardState | null = null;
let clients: Array<(data: string) => void> = [];

function broadcast(data: DashboardState): void {
  const json = JSON.stringify(data);
  for (const send of clients) {
    send(`data: ${json}\n\n`);
  }
}

export function startDashboard(port: number = 4200): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve dashboard HTML
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML);
      return;
    }

    // SSE endpoint for real-time updates
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const send = (data: string): void => { res.write(data); };
      clients.push(send);

      // Send current state immediately
      if (currentState) {
        send(`data: ${JSON.stringify(currentState)}\n\n`);
      }

      req.on('close', () => {
        clients = clients.filter(c => c !== send);
      });
      return;
    }

    // POST endpoint to update state
    if (url.pathname === '/update' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          currentState = JSON.parse(body) as DashboardState;
          currentState.updatedAt = Date.now();
          broadcast(currentState);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid JSON"}');
        }
      });
      return;
    }

    // API endpoint to get current state
    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(currentState ?? { message: 'No data yet. Send inspection data to POST /update' }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`\n  \x1b[36mContextGuard Dashboard\x1b[0m running at \x1b[1mhttp://localhost:${port}\x1b[0m`);
    console.log(`  \x1b[90mWaiting for inspection data on POST /update...\x1b[0m\n`);
  });
}
