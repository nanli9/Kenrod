'use client';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="py-16 px-4 text-center min-h-[60vh] flex flex-col items-center justify-center">
      <h1 className="text-6xl font-bold text-gray-300 mb-4">500</h1>
      <p className="text-xl text-gray-600 mb-8">Something went wrong.</p>
      <button
        onClick={reset}
        className="inline-block bg-accent text-white px-6 py-3 rounded-lg font-medium hover:bg-red-600 transition-colors"
      >
        Try again
      </button>
    </section>
  );
}
