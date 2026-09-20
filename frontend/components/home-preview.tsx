"use client";
import { useState } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, FileText, Folder, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import styles from "@/app/home.module.css";

const files = [
  { name: "src", access: "Can edit", kind: "dir", command: "apply_patch → src/greeting.ts", result: "Edit completed", detail: "The agent reported a successful edit inside an allowed folder.", allowed: true },
  { name: "tests", access: "Can edit", kind: "dir", command: "apply_patch → tests/greeting.test.ts", result: "Edit completed", detail: "Test files are writable under this example project’s permissions.", allowed: true },
  { name: "infra", access: "Read only", kind: "dir", command: "echo 'change' >> infra/prod.tf", result: "Write blocked", detail: "The folder is mounted read only. The attempted write returned a filesystem error.", allowed: false },
  { name: "sensitive_data", access: "No access", kind: "dir", command: "cat sensitive_data/example.txt", result: "Read blocked", detail: "The folder’s contents are hidden from the agent’s environment.", allowed: false },
  { name: "README.md", access: "Read only", kind: "file", command: "cat README.md", result: "Read completed", detail: "Read-only permission lets the agent inspect this file without modifying it.", allowed: true }
];
export function HomePreview() {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const file = files[selected];
  return <div className={styles.preview}>
    <div className={styles.previewToolbar}><div className={styles.windowDots} aria-hidden="true"><i /><i /><i /></div><span>acme / website</span><span className={styles.exampleBadge}>EXAMPLE SESSION</span></div>
    <div className={styles.previewBody}>
      <aside className={styles.filePanel}><div className={styles.panelHeading}>PROJECT FILES <span>5</span></div><p>Explore the permissions ↓</p><div className={styles.fileList}>{files.map((item, i) => <button key={item.name} onClick={() => { setSelected(i); setExpanded(false); }} aria-pressed={selected === i} className={selected === i ? styles.selectedFile : ""}>{item.kind === "dir" ? <ChevronRight size={12} /> : <FileText size={12} />}{item.kind === "dir" && <Folder size={14} />}<span>{item.name}</span><small className={item.access === "Can edit" ? styles.editBadge : item.access === "No access" ? styles.denyBadge : ""}>{item.access}</small></button>)}</div><div className={styles.scopeNote}><ShieldCheck size={17} /><span>Boundaries set.<br /><strong>Ready to build.</strong></span></div></aside>
      <div className={styles.activityPanel}><div className={styles.activityHeading}><div><span className={styles.eyebrow}>THE SESSION, AT A GLANCE</span><h3>Every attempt has a story.</h3></div><span className={styles.sessionPill}><span /> Preview</span></div><div className={styles.prompt}><span>YOU</span><p>Update the greeting and add a test.</p></div><div className={styles.toolCard}><div className={styles.toolTop}><span className={styles.toolIcon}><Terminal size={17} /></span><div><strong>{file.result}</strong><span>{file.name} · {file.access}</span></div><span className={file.allowed ? styles.resultAllowed : styles.resultBlocked}>{file.allowed ? <Check size={14} /> : <LockKeyhole size={13} />}{file.allowed ? "Allowed" : "Blocked"}</span></div><p>{file.detail}</p><button className={styles.expandCommand} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {expanded ? "Hide command" : "View command"}</button>{expanded && <pre className={styles.command}>{file.command}</pre>}</div><div className={styles.evidenceNote}><ArrowUpRight size={14} /> Tool reports and observed evidence, together in one view.</div></div>
    </div>
    <div className={styles.previewBottom}><span><ShieldCheck size={13} /> Project permissions applied</span><span>Your folder. Your terminal. Your call.</span></div>
  </div>;
}
