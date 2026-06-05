/**
 * /app/api/search/route.ts
 *
 * POST /api/search — the only request path the frontend uses for searches.
 * Thin wrapper over /lib/search-orchestrator.ts:
 *
 *   1. Parse JSON body
 *   2. Zod-validate against SearchInputSchema  → 400 on failure
 *   3. Call search(input)                       → branch on error class:
 *        - DistanceMatrixError   → 503 "Search temporarily unavailable"
 *        - CacheUnavailableError → 503 "Search temporarily unavailable"
 *        - anything else         → 500 "Something went wrong"
 *
 * Per tech-architecture §5.1: separate failure modes for "user gave bad
 * input" (400, with field-level details so the UI can render inline form
 * errors) and "our system broke" (5xx, short message only — full error
 * stays in server logs, no stack traces in responses).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { SearchInputSchema } from '@/types';
import {
  CacheUnavailableError,
  DistanceMatrixError,
  search,
} from '@/lib/search-orchestrator';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ─── Step 1: parse JSON body ───
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body — expected JSON.' },
      { status: 400 },
    );
  }

  // ─── Step 2: Zod-validate (safeParse keeps the control flow clean) ───
  const validation = SearchInputSchema.safeParse(body);
  if (!validation.success) {
    // Per the agreed approach: ship field-level details so the frontend can
    // render inline form errors. `issues` is structured ZodIssue[] — each
    // has `path` (array), `code`, and `message`. The schema shape is not
    // sensitive; no secrets leak.
    return NextResponse.json(
      { error: 'Invalid input', details: validation.error.issues },
      { status: 400 },
    );
  }
  const input = validation.data;

  // ─── Step 3: run the search ───
  try {
    const result = await search(input);
    return NextResponse.json(result);
  } catch (err) {
    // Log the full error server-side. console.error is picked up by Vercel
    // log drains. We do NOT log `input` itself — it carries the resolved
    // office address, the closest thing to PII we touch (tech-arch §7, §11).
    console.error('search failed', err);

    if (
      err instanceof DistanceMatrixError ||
      err instanceof CacheUnavailableError
    ) {
      // Both are upstream-dependency failures (Distance Matrix cold-start
      // fail, Redis read fail). Tech-architecture §10 maps these to 503
      // with a single user-facing message.
      return NextResponse.json(
        { error: 'Search temporarily unavailable. Try again in a moment.' },
        { status: 503 },
      );
    }

    // Anything else is an unexpected bug. Generic message to the client;
    // detail stays in server logs only.
    return NextResponse.json(
      { error: 'Something went wrong.' },
      { status: 500 },
    );
  }
}