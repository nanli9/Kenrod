'use client';

import { useEffect, useRef } from 'react';

// Acid dot + lagging ring. Desktop fine-pointers only; the ring swells over
// interactive elements. Touch and reduced-motion users keep the native cursor.
export default function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    document.documentElement.classList.add('custom-cursor');
    dot.style.opacity = '0';
    ring.style.opacity = '0';

    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let rx = mx;
    let ry = my;
    let hovering = false;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.opacity = '1';
      ring.style.opacity = '1';
      hovering = !!(e.target as Element | null)?.closest?.('a, button');
    };

    // Half-pixel quantised, and only written on change: an unconditional write
    // every frame invalidates the layer even when nothing moved, and WebKit
    // pays real compositor time for every invalidation above the hero canvas.
    let lx = -1;
    let ly = -1;
    let lrx = -1;
    let lry = -1;
    let lHov = false;
    const loop = () => {
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      const qrx = Math.round(rx * 2) / 2;
      const qry = Math.round(ry * 2) / 2;
      if (mx !== lx || my !== ly) {
        dot.style.transform = `translate(${mx}px, ${my}px)`;
        lx = mx;
        ly = my;
      }
      if (qrx !== lrx || qry !== lry || hovering !== lHov) {
        ring.style.transform = `translate(${qrx}px, ${qry}px) scale(${hovering ? 1.9 : 1})`;
        lrx = qrx;
        lry = qry;
      }
      if (hovering !== lHov) {
        ring.style.borderColor = hovering ? '#c6ff00' : 'rgba(245,245,243,0.35)';
        lHov = hovering;
      }
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
      document.documentElement.classList.remove('custom-cursor');
    };
  }, []);

  return (
    <>
      <div ref={dotRef} className="cursor-dot" aria-hidden />
      <div ref={ringRef} className="cursor-ring" aria-hidden />
    </>
  );
}
