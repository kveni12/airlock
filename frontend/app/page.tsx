import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight, Check, Eye, FolderGit2, ShieldCheck, Terminal } from "lucide-react";
import { HomePreview } from "@/components/home-preview";
import styles from "./home.module.css";

export default function Home() {
  return <div className={styles.home}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Periscope home"><Image src="/periscope-logo.png" alt="Periscope" width={2068} height={566} className={styles.fullLogo} priority /></Link>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#inside">A closer look</a><Link href="/projects" className={styles.navCta}>Open app <ArrowRight size={15} /></Link></nav>
    </header>

    <main>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> YOUR AGENT. YOUR BOUNDARIES.</p>
          <h1>Let your agent work.<br /><em>Keep it in sight.</em></h1>
          <p className={styles.intro}>Give your coding agent room to build, with clear limits on what it can touch. Periscope brings permissions and activity into one calm workspace.</p>
          <div className={styles.heroActions}><Link href="/projects/new" className={styles.primary}>Create a project <ArrowRight size={18} /></Link><a href="#how-it-works" className={styles.textLink}>See how it works <ArrowDown size={15} /></a></div>
          <div className={styles.compatibility}><span>AT HOME IN YOUR TERMINAL</span><span><Terminal size={14} /> Codex</span><span><Terminal size={14} /> Claude Code</span></div>
        </div>
        <div className={styles.radar} aria-hidden="true"><div className={styles.radarRing} /><div className={styles.radarRing} /><div className={styles.radarRing} /><div className={styles.radarCross} /><div className={styles.radarCore}><Image src="/periscope-mark.png" alt="" width={58} height={58} /></div><span className={styles.radarPoint} /><span className={styles.radarTag}><Check size={12} /> Within scope</span><span className={styles.radarLabel}>A LITTLE VISIBILITY GOES A LONG WAY.</span></div>
      </section>

      <section id="inside" className={styles.previewSection} aria-label="Interactive product example">
        <div className={styles.previewCaption}><span><span className={styles.smallDot} /> A CLEAR VIEW OF THE WORK</span><span>01 / THE WORKSPACE</span></div>
        <HomePreview />
        <p className={styles.previewNote}>An illustrative session. Your real projects and runs live in the app.</p>
      </section>

      <section id="how-it-works" className={styles.workflow}>
        <div className={styles.sectionHeading}><p className={styles.eyebrow}>LESS GUESSWORK. MORE BUILDING.</p><h2>Your usual workflow.<br /><em>A clearer view.</em></h2><p>Start in a local folder. Set the boundaries.<br />Keep working in the terminal you know.</p></div>
        <div className={styles.steps}>
          <article><span className={styles.stepNumber}>01</span><FolderGit2 size={25} strokeWidth={1.4} /><h3>Make room for the work.</h3><p>Choose a project folder and describe what your agent may do. Review the suggested file and network permissions.</p></article>
          <article><span className={styles.stepNumber}>02</span><Terminal size={25} strokeWidth={1.4} /><h3>Launch from your terminal.</h3><p>Start Codex or Claude Code through Periscope. Sign in with your agent account and give it a task.</p></article>
          <article><span className={styles.stepNumber}>03</span><Eye size={25} strokeWidth={1.4} /><h3>See what happens next.</h3><p>Follow reported tool attempts, results, and edits alongside observed activity. Inspect the permissions behind each run.</p></article>
        </div>
      </section>

      <section className={styles.closing}><div><ShieldCheck size={27} strokeWidth={1.5} /><p className={styles.eyebrow}>CONFIDENCE STARTS WITH CLARITY.</p><h2>A little oversight.<br /><em>A lot more possibility.</em></h2><p>Bring a project. Give your agent a place to work.</p></div><Link href="/projects/new" className={styles.primary}>Set up your workspace <ArrowRight size={18} /></Link></section>
    </main>
    <footer className={styles.footer}><Link href="/" className={styles.brand}><Image src="/periscope-logo.png" alt="Periscope" width={2068} height={566} className={styles.fullLogo} /></Link><span>Keep your agents in sight.</span><Link href="/projects">Go to workspace <ArrowRight size={14} /></Link></footer>
  </div>;
}
