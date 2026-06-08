'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { SearchResult } from '@/types';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN ?? '';
const MAP_STYLE = 'mapbox://styles/mapbox/streets-v12';
const BRAND_PRIMARY_FALLBACK = '#4f46e5';
const GURGAON_DEFAULT_CENTER: [number, number] = [77.09, 28.45];

function readBrandPrimary(): string {
  if (typeof window === 'undefined') return BRAND_PRIMARY_FALLBACK;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-brand-primary')
    .trim();
  return v || BRAND_PRIMARY_FALLBACK;
}

interface Props {
  result: SearchResult;
  active: boolean;
}

export function MapView({ result, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const brandColorRef = useRef<string>(BRAND_PRIMARY_FALLBACK);
  const hasInitRef = useRef(false);

  // Lazy init: only fires the first time `active` becomes true. Guarded by
  // hasInitRef so flipping the tab back and forth doesn't reinitialize.
  useEffect(() => {
    if (!active || hasInitRef.current || !containerRef.current) return;
    if (!MAPBOX_TOKEN) {
      console.warn(
        '[MapView] NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN is not set; map will not render.',
      );
      return;
    }

    mapboxgl.accessToken = MAPBOX_TOKEN;
    brandColorRef.current = readBrandPrimary();

    const office = result.search_metadata.offices_resolved[0];
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: office ? [office.lng, office.lat] : GURGAON_DEFAULT_CENTER,
      zoom: 11,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');

    map.on('load', () => {
      renderOverlays(map, result, brandColorRef.current, markersRef);
    });

    mapRef.current = map;
    hasInitRef.current = true;
    // We intentionally don't include `result` in deps — the second effect
    // below handles result updates after init. The closure here captures
    // whatever `result` is at first activation, which is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Unmount-only cleanup. Separate effect with [] deps so it doesn't fire
  // on every `active` flip — only when the component truly unmounts.
  useEffect(() => {
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      hasInitRef.current = false;
    };
  }, []);

  // Re-render overlays when `result` changes (only if map is already initialized).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasInitRef.current) return;

    const apply = () => renderOverlays(map, result, brandColorRef.current, markersRef);
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
  }, [result]);

  // Resize map when becoming visible after being CSS-hidden. Mapbox sizes
  // itself based on the container at init time; hidden → visible can leave
  // a blank canvas without a resize call.
  useEffect(() => {
    if (active && mapRef.current) {
      const t = setTimeout(() => mapRef.current?.resize(), 0);
      return () => clearTimeout(t);
    }
  }, [active]);

  const isochrone = result.search_metadata.isochrone;
  const clampedAt = isochrone?.clamped_at_minutes;

  return (
    <div className="relative h-[600px] w-full overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
      <div ref={containerRef} className="h-full w-full" />

      {clampedAt !== undefined && (
        <div className="absolute right-4 top-4 z-10 max-w-xs rounded-lg border border-gray-200 bg-white/95 px-3 py-2 text-xs shadow-md backdrop-blur">
          <p className="font-semibold text-black">Map shows the 60-min reachable area.</p>
          <p className="mt-0.5 text-gray-500">
            Your full {clampedAt}-min results are in the list.
          </p>
        </div>
      )}

      {!isochrone && (
        <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-gray-200 bg-white/95 px-3 py-1.5 text-xs text-gray-500 shadow-md backdrop-blur">
          Reachable area unavailable.
        </div>
      )}

      {!MAPBOX_TOKEN && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-50 p-6 text-center text-sm text-gray-500">
          <div>
            Map unavailable: <code className="rounded bg-gray-100 px-1.5 py-0.5">NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN</code> is not set.
          </div>
        </div>
      )}
    </div>
  );
}

function renderOverlays(
  map: mapboxgl.Map,
  result: SearchResult,
  brandColor: string,
  markersRef: React.MutableRefObject<mapboxgl.Marker[]>,
) {
  // Clear old markers
  markersRef.current.forEach((m) => m.remove());
  markersRef.current = [];

  // Clear old isochrone layers/source
  if (map.getLayer('isochrone-fill')) map.removeLayer('isochrone-fill');
  if (map.getLayer('isochrone-line')) map.removeLayer('isochrone-line');
  if (map.getSource('isochrone')) map.removeSource('isochrone');

  const office = result.search_metadata.offices_resolved[0];
  const isochrone = result.search_metadata.isochrone;

  // Isochrone (if present). Mapbox handles Polygon and MultiPolygon natively.
  if (isochrone) {
    map.addSource('isochrone', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: isochrone.geometry,
        properties: {},
      },
    });
    map.addLayer({
      id: 'isochrone-fill',
      type: 'fill',
      source: 'isochrone',
      paint: { 'fill-color': brandColor, 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'isochrone-line',
      type: 'line',
      source: 'isochrone',
      paint: { 'line-color': brandColor, 'line-width': 2, 'line-opacity': 0.85 },
    });
  }

  // Office marker — solid black rounded square, visually distinct from circles.
  if (office) {
    const el = document.createElement('div');
    Object.assign(el.style, {
      width: '20px',
      height: '20px',
      background: '#0a0a0a',
      border: '3px solid #ffffff',
      borderRadius: '5px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      cursor: 'default',
    } as Partial<CSSStyleDeclaration>);

    const popup = new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(
      `<div style="font-weight:600;font-size:13px;color:#0a0a0a;">Office</div>`,
    );
    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([office.lng, office.lat])
      .setPopup(popup)
      .addTo(map);
    markersRef.current.push(marker);
  }

  // Numbered locality pins — matches the rank circles in LocalityRow.
  result.results.forEach((r, idx) => {
    const rank = idx + 1;
    const el = document.createElement('div');
    Object.assign(el.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '32px',
      height: '32px',
      borderRadius: '9999px',
      background: brandColor,
      color: '#ffffff',
      fontWeight: '700',
      fontSize: '14px',
      border: '2px solid #ffffff',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      cursor: 'pointer',
    } as Partial<CSSStyleDeclaration>);
    el.textContent = String(rank);

    const popup = new mapboxgl.Popup({ offset: 22, closeButton: false }).setHTML(
      `<div style="font-family:inherit;min-width:140px;">
         <div style="font-weight:700;font-size:14px;color:#0a0a0a;margin-bottom:2px;">#${rank} · ${escapeHtml(r.locality.name)}</div>
         <div style="font-size:12px;color:#6b7280;">Score: ${r.score.final_score.toFixed(2)}</div>
       </div>`,
    );

    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([r.locality.centroid.lng, r.locality.centroid.lat])
      .setPopup(popup)
      .addTo(map);
    markersRef.current.push(marker);
  });

  // Fit bounds to office + all locality markers, with padding.
  const bounds = new mapboxgl.LngLatBounds();
  let hasPoint = false;
  if (office) {
    bounds.extend([office.lng, office.lat]);
    hasPoint = true;
  }
  result.results.forEach((r) => {
    bounds.extend([r.locality.centroid.lng, r.locality.centroid.lat]);
    hasPoint = true;
  });
  if (hasPoint) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}