export function SectionTitle({
  title,
  description,
}: {
  title: string | React.ReactNode;
  description?: string | React.ReactNode;
  titleComponent?: React.ReactNode;
}) {
  const titleElement =
    Object.prototype.toString.call(title) === "[object String]" ? (
      <h3 className="text-foreground mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
        {title}
      </h3>
    ) : (
      title
    );
  const descriptionElement =
    Object.prototype.toString.call(description) === "[object String]" ? (
      <p className="text-muted-foreground mt-4 text-lg leading-8">
        {description}
      </p>
    ) : (
      description
    );

  return (
    <div className="mx-auto mb-8 max-w-2xl text-center">
      {titleElement}
      {descriptionElement}
    </div>
  );
}
