export default function Section({
  title,
  children,
  className = '',
  dark = false,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  dark?: boolean;
}) {
  return (
    <section
      className={`py-16 px-4 sm:px-6 lg:px-8 ${
        dark ? 'bg-primary text-white' : 'bg-white'
      } ${className}`}
    >
      <div className="max-w-7xl mx-auto">
        {title && (
          <h2 className="text-3xl font-bold text-center mb-12">{title}</h2>
        )}
        {children}
      </div>
    </section>
  );
}
