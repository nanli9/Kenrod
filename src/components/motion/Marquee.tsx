'use client';

// Infinite band: content is duplicated and the track translates -50%.
export default function Marquee({
  children,
  className = '',
  trackClassName = '',
}: {
  children: React.ReactNode;
  className?: string;
  trackClassName?: string;
}) {
  return (
    <div className={`overflow-hidden whitespace-nowrap ${className}`}>
      <div className={`inline-flex animate-marquee will-change-transform ${trackClassName}`}>
        <span className="inline-flex shrink-0 items-center">{children}</span>
        <span className="inline-flex shrink-0 items-center" aria-hidden>
          {children}
        </span>
      </div>
    </div>
  );
}
