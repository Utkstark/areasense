// app/api/office-suggest/route.ts
//
// GET /api/office-suggest?q=...
// Returns up to 5 office suggestions for the given partial input.
// Empty array for queries < 2 chars (matches client-side debounce assumption).

import { NextRequest, NextResponse } from 'next/server';
import { suggestOffices } from '@/lib/office-suggest';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';

  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const suggestions = await suggestOffices(q);
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error('office-suggest failed', err);
    return NextResponse.json(
      { error: 'Suggestion service unavailable' },
      { status: 503 }
    );
  }
}