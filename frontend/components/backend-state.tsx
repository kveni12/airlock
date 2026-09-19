import { AlertTriangle, DatabaseZap, RefreshCw } from "lucide-react";

export function LoadingState() {
  return <div className="grid gap-4 md:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="card h-36 p-5"><div className="skeleton h-3 w-24" /><div className="skeleton mt-5 h-9 w-16" /><div className="skeleton mt-4 h-3 w-36" /></div>)}</div>;
}

export function ConnectionError({ message, onRetry, demoFallback = true }: { message: string; onRetry: () => void; demoFallback?: boolean }) {
  return <div className="mb-5 flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" /><div><p className="text-sm font-semibold">Backend unavailable</p><p className="mt-1 text-sm text-[#64717c]">{message}</p>{demoFallback ? <p className="mt-1 text-xs text-amber-800">The page is showing labeled demo data.</p> : null}</div></div><button onClick={onRetry} className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw className="size-4" />Retry</button></div>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="card grid min-h-60 place-items-center p-10 text-center"><div><DatabaseZap className="mx-auto size-7 text-[#64717c]" /><h2 className="mt-4 font-semibold">{title}</h2><p className="mt-1 max-w-md text-sm text-[#64717c]">{body}</p></div></div>;
}
