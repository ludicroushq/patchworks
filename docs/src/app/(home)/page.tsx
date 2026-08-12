import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 md:py-24">
      <div className="max-w-3xl text-center">
        <h1 className="mb-4 text-4xl font-extrabold md:text-5xl">Patchworks</h1>
        <p className="mb-6 text-xl text-fd-muted-foreground">
          Keep projects connected to their source templates, one reviewable
          commit at a time.
        </p>

        <div className="flex flex-wrap justify-center gap-4 mb-12">
          <Link
            href="/docs"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            Documentation
          </Link>
          <Link
            href="/docs/setup-service"
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-6 py-2 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
          >
            Done-for-you setup
          </Link>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          <div className="rounded-lg border p-6">
            <h2 className="mb-2 text-xl font-bold">Problem</h2>
            <p className="text-fd-muted-foreground">
              When you clone a template repository, you lose the connection to
              the original template. If the template author fixes a bug or makes
              an improvement, there's no easy way to pull those changes into
              your repository.
            </p>
          </div>
          <div className="rounded-lg border p-6">
            <h2 className="mb-2 text-xl font-bold">Solution</h2>
            <p className="text-fd-muted-foreground">
              Patchworks creates an automated system that tracks which template
              repository your project was based on and helps you stay updated
              with changes.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
