// app/api/office-resolve/route.ts
//
// GET /api/office-resolve?placeId=...
// Resolves a Google Place ID to coordinates. Called once per user selection
// from the autocomplete dropdown (not per keystroke).

import { NextRequest, NextResponse } from 'next/server';
import { resolveOfficeCoordinates } from '@/lib/office-suggest';

export async function GET(req: NextRequest) {
  const placeId = req.nextUrl.searchParams.get('placeId');

  if (!placeId) {
    return NextResponse.json(
      { error: 'placeId is required' },
      { status: 400 }
    );
  }

  try {
    const coordinates = await resolveOfficeCoordinates(placeId);
    return NextResponse.json({ coordinates });
  } catch (err) {
    console.error('office-resolve failed', err);
    return NextResponse.json(
      { error: 'Could not resolve location' },
      { status: 503 }
    );
  }
}