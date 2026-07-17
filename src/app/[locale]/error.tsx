'use client';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="py-16 px-4 text-center min-h-[70vh] flex flex-col items-center justify-center bg-lacquer">
      <p className="font-mono text-xs tracking-[0.35em] text-brass/90 uppercase mb-6">
        Error / 500
      </p>
      <h1 className="font-display text-6xl md:text-7xl font-bold text-ivory mb-4">500</h1>
      <p className="text-bone mb-10">Something went wrong.</p>
      <button
        onClick={reset}
        className="inline-flex h-11 items-center px-7 rounded-full bg-jade text-white text-sm font-medium hover:bg-jade-bright hover:text-lacquer transition-colors"
      >
        Try again
      </button>
    </section>
  );
}
