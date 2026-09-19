"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bot, FolderGit2, GitBranch, LayoutDashboard, LogOut, MessageSquarePlus, ScanSearch } from "lucide-react";
import { AuthGate, useAuth } from "./auth-gate";
import { RuntimeIndicator } from "./runtime-indicator";
import { API_BASE_URL } from "@/lib/api";

const navigation = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/runs", label: "Runs", icon: GitBranch },
  { href: "/requests", label: "New request", icon: MessageSquarePlus },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/reviews", label: "Reviews", icon: ScanSearch },
  { href: "/activity", label: "Activity", icon: Activity }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AuthGate><AuthenticatedShell>{children}</AuthenticatedShell></AuthGate>;
}

function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <div className="min-h-screen md:grid md:grid-cols-[240px_minmax(0,1fr)]">
    <aside className="border-b border-white/10 bg-[#182a33] text-white md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-b-0 md:border-r">
      <div className="flex items-center justify-between px-4 py-4 md:px-5 md:py-6">
        <Link href="/overview" className="flex items-center gap-3 font-semibold tracking-tight"><span className="grid size-9 place-items-center rounded-lg bg-[#f6f2ec]"><Image src="/periscope-mark.png" alt="" width={28} height={28} priority /></span><span className="tracking-[.18em] uppercase text-sm">Periscope</span></Link>
        <span className="rounded-full border border-white/15 px-2 py-1 text-[10px] uppercase tracking-wider text-white/60">MVP</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:px-3 md:pb-0">
        {navigation.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return <Link key={href} href={href} className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "bg-[#d1b191] font-semibold text-[#182a33]" : "text-white/70 hover:bg-white/10 hover:text-white"}`}><Icon className="size-4" />{label}</Link>;
        })}
      </nav>
      <div className="mt-auto hidden border-t border-white/10 p-5 text-xs text-white/55 md:block"><p>Runtime evidence</p><p className="mono mt-1 break-all">{API_BASE_URL.replace(/^https?:\/\//, "")}</p></div>
    </aside>
    <div className="min-w-0">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-[#fbfbfa]/90 px-4 backdrop-blur md:px-7"><span className="mono text-xs uppercase tracking-[.14em] text-[#64717c]">workspace / periscope</span><div className="flex items-center gap-4"><RuntimeIndicator /><CurrentUser /></div></header>
      <main className="p-4 md:p-7 lg:p-9">{children}</main>
    </div>
  </div>;
}

function CurrentUser() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return <div className="flex items-center gap-2 text-xs text-[#64717c]">
    <span className="hidden sm:inline" title={user.email}>{user.displayName}</span>
    <button onClick={() => void signOut()} title="Sign out" className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-semibold hover:bg-white"><LogOut className="size-3.5" />Sign out</button>
  </div>;
}
