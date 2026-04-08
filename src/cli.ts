#!/usr/bin/env node
/**
 * ContextGuard CLI
 *
 * Usage:
 *   contextguard inspect <messages.json>     Inspect a messages file
 *   contextguard demo                        Run with demo data
 *   contextguard health                      Quick health check on stdin
 *   contextguard --help                      Show help
 *
 * Messages JSON format (Anthropic/OpenAI compatible):
 *   [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }, ...]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { ContextInspector } from './inspector/index.js';
import { detectProvider } from './providers/index.js';
import { runDemoScenario } from './demo/scenario.js';
import { startDashboard } from './dashboard/server.js';
import { AnalyticsStore } from './engine/analyticsStore.js';
import { revive, serializeManifest, parseManifest, verify, expand } from './revive/index.js';
import { parseSessionJsonl } from './revive/formats/jsonl.js';
import type { ReviveTier } from './revive/index.js';
import type { Message, Provider } from './types/index.js';

const HELP = `
\x1b[1m\x1b[36mContextGuard\x1b[0m — Context budget management for AI applications

\x1b[1mUSAGE\x1b[0m
  contextguard inspect <file>   Analyze a messages JSON file
  contextguard demo             Run with demo data to see what it does
  contextguard scenario         Run budget enforcement demo (before/after)
  contextguard health <file>    Quick health score (no details)
  contextguard dashboard        Start web dashboard on port 4200
  contextguard stats            Show analytics from past sessions
  contextguard revive <file>    Compact a session JSONL — your AI's drink
  contextguard revive-verify <manifest> <original>   Prove a manifest is intact
  contextguard revive-expand <manifest> <spanId> <original>  Rehydrate a span
  contextguard --help           Show this help

\x1b[1mOPTIONS\x1b[0m
  --model <name>    Model name (default: claude-sonnet-4-6)
  --provider <name> Provider: anthropic, openai, generic (auto-detected from model)
  --json            Output as JSON instead of formatted text
  --port <number>   Dashboard port (default: 4200)

\x1b[1mEXAMPLES\x1b[0m
  contextguard demo
  contextguard scenario
  contextguard inspect conversation.json --model gpt-4o
  contextguard health messages.json --json
  contextguard dashboard --port 8080
  contextguard revive session.jsonl --sparkling
  contextguard revive session.jsonl --sparkling --out session.compact.jsonl
  contextguard revive-verify manifest.json original.jsonl
  contextguard revive-expand manifest.json 7 original.jsonl

\x1b[1mREVIVE\x1b[0m
  Sprint 1 ships the \x1b[36mSparkling\x1b[0m tier (20-30% reduction, 99% recall floor).
  Electrolyte and IV tiers ship in Sprints 2-3.
  Manifest stored at .contextguard/revive-{timestamp}.json by default.

\x1b[1mMESSAGES FORMAT\x1b[0m
  Standard OpenAI/Anthropic messages array:
  [{ "role": "system"|"user"|"assistant"|"tool", "content": "..." }, ...]
`;

function generateDemoMessages(): Message[] {
  return [
    {
      role: 'system',
      content: `You are a helpful AI assistant specialized in software architecture review.
You follow these principles:
1. Always consider security implications
2. Prefer simple solutions over complex ones
3. Consider maintainability and team skill level
4. Evaluate cost-performance tradeoffs

When reviewing code, check for:
- OWASP Top 10 vulnerabilities
- Performance bottlenecks
- Code duplication
- Missing error handling
- Insufficient logging`,
    },
    {
      role: 'user',
      content: 'I need help designing a new microservice for handling user authentication. We currently have a monolithic Django app and want to extract the auth module.',
    },
    {
      role: 'assistant',
      content: `Great question. Let me break down the key architectural decisions for extracting auth into a microservice.

**1. Token Format**: JWT vs opaque tokens
- JWT: Stateless, good for distributed systems, but can't revoke without extra infrastructure
- Opaque: Requires a token store (Redis), but gives you instant revocation

**2. Service Communication**:
- Sync (REST/gRPC) for auth checks
- Async (events) for user lifecycle events

**3. Data Migration**:
- Users table extraction
- Session migration strategy
- Backwards compatibility during transition

**4. Security Considerations**:
- Token rotation policy
- Rate limiting on auth endpoints
- MFA support from day one
- Audit logging for all auth events

I'd recommend starting with JWT + Redis blacklist for the best of both worlds. Want me to detail any of these areas?`,
    },
    {
      role: 'user',
      content: 'Yes, let me also share our current auth middleware code for review.',
    },
    {
      role: 'user',
      content: `Here's our current authentication middleware:

\`\`\`python
import jwt
from django.conf import settings
from django.contrib.auth.models import User
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
import logging
import redis
from datetime import datetime, timedelta
import hashlib
import hmac

logger = logging.getLogger(__name__)
redis_client = redis.Redis(host='localhost', port=6379, db=0)

class JWTAuthentication(BaseAuthentication):
    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION')
        if not auth_header:
            return None

        try:
            prefix, token = auth_header.split(' ')
            if prefix.lower() != 'bearer':
                return None
        except ValueError:
            raise AuthenticationFailed('Invalid authorization header format')

        # Check blacklist
        if redis_client.get(f'blacklist:{token}'):
            raise AuthenticationFailed('Token has been revoked')

        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            raise AuthenticationFailed('Token has expired')
        except jwt.InvalidTokenError:
            raise AuthenticationFailed('Invalid token')

        try:
            user = User.objects.get(id=payload['user_id'])
        except User.DoesNotExist:
            raise AuthenticationFailed('User not found')

        if not user.is_active:
            raise AuthenticationFailed('User account is disabled')

        # Rate limiting
        rate_key = f'auth_rate:{user.id}'
        current = redis_client.incr(rate_key)
        if current == 1:
            redis_client.expire(rate_key, 60)
        if current > 100:
            raise AuthenticationFailed('Rate limit exceeded')

        logger.info(f'Authenticated user {user.id} via JWT')
        return (user, token)

    @staticmethod
    def generate_token(user):
        payload = {
            'user_id': user.id,
            'exp': datetime.utcnow() + timedelta(hours=24),
            'iat': datetime.utcnow(),
            'jti': hashlib.sha256(f'{user.id}{datetime.utcnow()}'.encode()).hexdigest()
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm='HS256')

    @staticmethod
    def revoke_token(token):
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=['HS256'])
            ttl = payload['exp'] - datetime.utcnow().timestamp()
            if ttl > 0:
                redis_client.setex(f'blacklist:{token}', int(ttl), '1')
        except jwt.InvalidTokenError:
            pass
\`\`\`

Can you review this and suggest improvements for the microservice extraction?`,
    },
    {
      role: 'assistant',
      content: `Good code to start from. Here's my review with extraction recommendations:

**Security Issues to Fix During Extraction:**
1. Using \`settings.SECRET_KEY\` for JWT — extract to dedicated JWT signing key
2. HS256 is symmetric — consider RS256 for the microservice (allows public key verification without sharing the signing key)
3. Rate limiting by user ID only — add IP-based limiting for pre-auth endpoints
4. No CSRF protection for token generation endpoint

**Architecture Recommendations:**
1. Replace Django User model dependency with a standalone user store
2. Add token refresh endpoint (separate from generation)
3. Implement proper key rotation (JWKS endpoint)
4. Add health check endpoint for service discovery
5. Structured logging (JSON) instead of string formatting

Would you like me to draft the microservice API contract?`,
    },
    {
      role: 'tool',
      content: `Search results for "JWT microservice best practices 2024":
1. OWASP JWT Security Cheat Sheet - recommends RS256, short expiry, proper validation
2. Auth0 Architecture Guide - token refresh patterns, PKCE for public clients
3. Google Cloud Auth Microservice - sidecar pattern, mesh-level auth
4. Netflix Zuul - gateway-level auth with token exchange`,
    },
    {
      role: 'user',
      content: 'Yes, please draft the API contract. Also, what about session management during the migration period?',
    },
  ];
}

function parseArgs(args: string[]): { command: string; file?: string; model: string; provider?: Provider; json: boolean } {
  const command = args[0] ?? 'help';
  let file: string | undefined;
  let model = 'claude-sonnet-4-6';
  let provider: Provider | undefined;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' && args[i + 1]) {
      model = args[++i]!;
    } else if (arg === '--provider' && args[i + 1]) {
      provider = args[++i] as Provider;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--out' && args[i + 1]) {
      // --out <path> is consumed by the revive subcommand via a
      // direct scan of `args`, not by this parser. Skip the value
      // here so it doesn't get picked up as a positional `file`.
      i++;
    } else if (arg?.startsWith('--tier') || arg === '--sparkling' || arg === '--electrolyte' || arg === '--iv') {
      // Tier flags are consumed by parseTierFlag() in the revive
      // subcommand. Skip them here so they don't trip the fallthrough.
      // `--tier` may be either `--tier sparkling` or `--tier=sparkling`;
      // consume a following positional only if it exists and isn't a flag.
      if (arg === '--tier' && args[i + 1] && !args[i + 1]!.startsWith('--')) i++;
    } else if (!arg?.startsWith('--')) {
      file = arg;
    }
  }

  return { command, file, model, provider: provider ?? detectProvider(model), json };
}

function loadMessages(file: string): Message[] {
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('Error: Messages file must contain a JSON array');
      process.exit(1);
    }
    return parsed as Message[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error reading file: ${message}`);
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });

    // If stdin is a TTY (no pipe), resolve immediately with empty
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const parsed = parseArgs(args);
  const inspector = new ContextInspector({
    provider: parsed.provider,
    model: parsed.model,
  });

  switch (parsed.command) {
    case 'demo': {
      const messages = generateDemoMessages();
      inspector.loadMessages(messages);
      const result = inspector.inspect();

      if (parsed.json) {
        const { display: _display, ...data } = result;
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(result.display);
        console.log('  \x1b[90mThis is demo data. Use "contextguard inspect <file>" with real messages.\x1b[0m');
        console.log('');
      }
      break;
    }

    case 'inspect': {
      let messages: Message[];
      if (parsed.file) {
        messages = loadMessages(parsed.file);
      } else {
        const stdin = await readStdin();
        if (!stdin) {
          console.error('Error: No file specified and no stdin data. Use: contextguard inspect <file>');
          process.exit(1);
        }
        messages = JSON.parse(stdin) as Message[];
      }

      inspector.loadMessages(messages);
      const result = inspector.inspect();

      if (parsed.json) {
        const { display: _display, ...data } = result;
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(result.display);
      }
      break;
    }

    case 'health': {
      let messages: Message[];
      if (parsed.file) {
        messages = loadMessages(parsed.file);
      } else {
        const stdin = await readStdin();
        if (!stdin) {
          console.error('Error: No file specified and no stdin data.');
          process.exit(1);
        }
        messages = JSON.parse(stdin) as Message[];
      }

      inspector.loadMessages(messages);
      const result = inspector.inspect();

      if (parsed.json) {
        console.log(JSON.stringify(result.health, null, 2));
      } else {
        console.log(`\n  Health: ${result.health.grade} (${result.health.score}/100)\n`);
        for (const rec of result.health.recommendations) {
          console.log(`  \x1b[33m\u25B6\x1b[0m ${rec}`);
        }
        console.log('');
      }
      break;
    }

    case 'scenario': {
      const output = runDemoScenario();
      console.log(output);
      break;
    }

    case 'dashboard': {
      let port = 4200;
      const portIdx = args.indexOf('--port');
      if (portIdx !== -1 && args[portIdx + 1]) {
        port = parseInt(args[portIdx + 1]!, 10);
      }
      startDashboard(port);
      break;
    }

    case 'stats': {
      try {
        const store = new AnalyticsStore();
        const stats = store.getStats();
        const recent = store.getRecentSessions(10);

        if (parsed.json) {
          console.log(JSON.stringify({ stats, recentSessions: recent }, null, 2));
        } else {
          console.log('');
          console.log('  \x1b[1m\x1b[36mContextGuard Analytics\x1b[0m');
          console.log('  \x1b[90m' + '\u2500'.repeat(40) + '\x1b[0m');
          console.log(`  Total sessions:    ${stats.totalSessions}`);
          console.log(`  Avg health score:  ${stats.avgHealth}/100`);
          console.log(`  Total items pruned: ${stats.totalPruned}`);
          console.log(`  Total violations:  ${stats.totalViolations}`);
          console.log(`  Avg peak tokens:   ${stats.avgPeakTokens.toLocaleString()}`);
          console.log('');

          if (recent.length > 0) {
            console.log('  \x1b[1mRecent Sessions:\x1b[0m');
            for (const s of recent) {
              const date = new Date(s.started_at).toLocaleDateString();
              const grade = s.final_grade ?? '?';
              console.log(`    ${date}  ${grade.padEnd(3)} ${s.model.padEnd(25)} peak: ${s.peak_tokens.toLocaleString().padStart(8)} pruned: ${s.items_pruned}`);
            }
            console.log('');
          }
        }

        store.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  \x1b[90mNo analytics data yet. ${msg}\x1b[0m\n`);
      }
      break;
    }

    case 'revive': {
      if (!parsed.file) {
        console.error('Error: revive requires a file argument. Usage: contextguard revive <session.jsonl>');
        process.exit(1);
      }
      const tier = parseTierFlag(args);
      const outFlagIdx = args.indexOf('--out');
      const outPath = outFlagIdx !== -1 && args[outFlagIdx + 1] ? args[outFlagIdx + 1] : undefined;

      const sourceText = readFileSync(parsed.file, 'utf-8');
      const result = revive(sourceText, { tier, originalPath: parsed.file, format: 'jsonl' });

      // Write compacted output
      const finalOutPath = outPath ?? defaultCompactedPath(parsed.file);
      writeFileSync(finalOutPath, result.compacted, 'utf-8');

      // Write manifest + GIA-compatible ledger entry
      const manifestDir = '.contextguard';
      if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const manifestPath = join(manifestDir, `revive-${ts}.json`);
      writeFileSync(manifestPath, serializeManifest(result.manifest), 'utf-8');
      const ledgerPath = join(manifestDir, `ledger-${ts}.json`);
      writeFileSync(ledgerPath, JSON.stringify(result.ledgerEntry, null, 2) + '\n', 'utf-8');

      if (parsed.json) {
        console.log(JSON.stringify({
          tier,
          originalTokens: result.originalTokens,
          compactedTokens: result.compactedTokens,
          reductionPct: result.reductionPct,
          beforeGrade: result.beforeGrade.grade,
          afterGrade: result.afterGrade.grade,
          chainGrade: result.chain.grade,
          chainApproved: result.chain.approved,
          chainSummary: result.chain.summary,
          preservedByWeight: result.chain.preservedByWeight,
          lostByWeight: result.chain.lostByWeight,
          outPath: finalOutPath,
          manifestPath,
        }, null, 2));
      } else {
        printReviveResult(tier, result, finalOutPath, manifestPath);
      }
      break;
    }

    case 'revive-verify': {
      const manifestPath = args[1];
      const originalPath = args[2];
      if (!manifestPath || !originalPath) {
        console.error('Error: revive-verify requires <manifest> and <original> arguments.');
        process.exit(1);
      }
      const manifest = parseManifest(readFileSync(manifestPath, 'utf-8'));
      // Reconstruct the same flat-text representation revive() used.
      const originalSource = reconstructFlatText(readFileSync(originalPath, 'utf-8'));
      const verifyResult = verify(manifest, originalSource);
      if (parsed.json) {
        console.log(JSON.stringify(verifyResult, null, 2));
      } else {
        const icon = verifyResult.ok ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
        console.log(`\n  ${icon} ${verifyResult.summary}`);
        console.log(`    Preserved: ${verifyResult.preservedOk} ok, ${verifyResult.preservedFailed} failed`);
        console.log(`    Dropped:   ${verifyResult.droppedOk} ok, ${verifyResult.droppedFailed} failed`);
        console.log(`    Original intact: ${verifyResult.originalIntact}\n`);
      }
      if (!verifyResult.ok) process.exit(2);
      break;
    }

    case 'revive-expand': {
      const manifestPath = args[1];
      const spanIdRaw = args[2];
      const originalPath = args[3];
      if (!manifestPath || !spanIdRaw || !originalPath) {
        console.error('Error: revive-expand requires <manifest> <spanId> <original>.');
        process.exit(1);
      }
      const spanId = parseInt(spanIdRaw, 10);
      if (Number.isNaN(spanId)) {
        console.error('Error: spanId must be an integer.');
        process.exit(1);
      }
      const manifest = parseManifest(readFileSync(manifestPath, 'utf-8'));
      const originalSource = reconstructFlatText(readFileSync(originalPath, 'utf-8'));
      const expandResult = expand(manifest, spanId, originalSource);
      if (!expandResult.verified) {
        console.error(`Failed to expand span ${spanId}: ${expandResult.reason}`);
        process.exit(2);
      }
      if (parsed.json) {
        console.log(JSON.stringify({ spanId, text: expandResult.text }, null, 2));
      } else {
        console.log(expandResult.text);
      }
      break;
    }

    default:
      console.log(HELP);
  }
}

// ─── Revive helpers ─────────────────────────────────────────────────

function parseTierFlag(args: string[]): ReviveTier {
  if (args.includes('--iv')) return 'iv';
  if (args.includes('--electrolyte')) return 'electrolyte';
  return 'sparkling';
}

function defaultCompactedPath(originalPath: string): string {
  const dir = dirname(originalPath);
  const name = basename(originalPath);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return join(dir, `${name}.compact`);
  return join(dir, `${name.slice(0, dot)}.compact${name.slice(dot)}`);
}

function reconstructFlatText(jsonlSource: string): string {
  // Mirror the flat-text format produced by parseSessionJsonl so the
  // verifier sees the same offsets the manifest references.
  return parseSessionJsonl(jsonlSource).flatText;
}

function printReviveResult(
  tier: ReviveTier,
  result: ReturnType<typeof revive>,
  outPath: string,
  manifestPath: string
): void {
  const tierEmoji = tier === 'iv' ? '\u{1F489}' : tier === 'electrolyte' ? '\u{1F964}' : '\u{1F9CA}';
  const reductionPctDisplay = (result.reductionPct * 100).toFixed(1);
  const beforeIcon = result.beforeGrade.grade === 'A' || result.beforeGrade.grade === 'B' ? '\u2615' : '\u{1F975}';
  const afterIcon = '\u{1F964}';
  console.log('');
  console.log(`  \x1b[1m\x1b[36mContextGuard Revive\x1b[0m  ${tierEmoji}  tier: \x1b[1m${tier}\x1b[0m`);
  console.log('  \x1b[90m' + '\u2500'.repeat(50) + '\x1b[0m');
  console.log(`  Before:  Grade \x1b[1m${result.beforeGrade.grade}\x1b[0m  (${result.originalTokens.toLocaleString()} tokens)`);
  console.log(`  After:   Grade \x1b[1m${result.afterGrade.grade}\x1b[0m  (${result.compactedTokens.toLocaleString()} tokens)`);
  console.log(`  Saved:   \x1b[32m${(result.originalTokens - result.compactedTokens).toLocaleString()} tokens\x1b[0m  (${reductionPctDisplay}%)`);
  console.log('');
  console.log(`  Preserved: ${result.manifest.preserved.length} anchors`);
  console.log(`  Dropped:   ${result.manifest.dropped.length} spans`);
  console.log('');

  // ─── Evidence Chain Validation ─────────────────────────────────
  const chain = result.chain;
  const gradeColor =
    chain.grade === 'A' || chain.grade === 'B'
      ? '\x1b[32m'
      : chain.grade === 'C' || chain.grade === 'D'
        ? '\x1b[33m'
        : '\x1b[31m';
  console.log(`  \x1b[1m\x1b[36mEvidence Chain Validation\x1b[0m`);
  console.log('  \x1b[90m' + '\u2500'.repeat(50) + '\x1b[0m');
  printLevel('Level 1 Structural Integrity', chain.level1.passed);
  printLevel('Level 2 Evidence Preservation', chain.level2.passed);
  console.log(`      High probative:     ${chain.preservedByWeight.high}/${chain.preservedByWeight.high + chain.lostByWeight.high} preserved`);
  console.log(`      Moderate probative: ${chain.preservedByWeight.moderate}/${chain.preservedByWeight.moderate + chain.lostByWeight.moderate} preserved`);
  console.log(`      Low probative:      ${chain.preservedByWeight.low}/${chain.preservedByWeight.low + chain.lostByWeight.low} preserved`);
  printLevel('Level 3 Drift / Addition Check', chain.level3.passed);
  printLevel('Level 4 Recovery Sufficiency', chain.level4.passed);
  console.log('');
  const approval = chain.approved ? 'APPROVED FOR USE' : 'NOT APPROVED';
  const approvalColor = chain.approved ? '\x1b[32m' : '\x1b[31m';
  console.log(`  Chain Grade: ${gradeColor}\x1b[1m${chain.grade}\x1b[0m   ${approvalColor}${approval}\x1b[0m`);
  console.log('');

  console.log(`  Output:    ${outPath}`);
  console.log(`  Manifest:  ${manifestPath}`);
  if (result.ledgerEntry.entryHash) {
    console.log(`  Ledger:    entryHash ${result.ledgerEntry.entryHash.slice(0, 16)}...`);
  }
  console.log('');
  console.log(`  Felt difference: ${beforeIcon} \u2192 ${afterIcon}  Your AI just got a drink.`);
  console.log('');
}

function printLevel(name: string, passed: boolean): void {
  const icon = passed ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
  console.log(`  ${icon} ${name}`);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
