#!/usr/bin/env node
// Build the Projects-v2 CSV and the gh-CLI creation script from the issue files.
// Run: node node docs/github/scripts/build-artifacts.mjs (from repo root)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GH_DIR = join(__dirname, "..");
const ISSUES_DIR = join(GH_DIR, "issues");
const CSV_PATH = join(GH_DIR, "issues-projects-v2.csv");
const SH_PATH = join(GH_DIR, "CREATE-ISSUES.sh");

const PRIORITY_RANK = { "P0-critical": "Urgent", "P1-high": "High", "P2-medium": "Medium", "P3-low": "Low" };

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("Missing frontmatter");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    fm[kv[1]] = val;
  }
  return { fm, body: m[2].trim() };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function priorityOf(labels) {
  const pr = labels.find(l => l.startsWith("priority:"));
  return pr ? PRIORITY_RANK[pr.slice("priority:".length)] : "Medium";
}

const files = readdirSync(ISSUES_DIR).filter(f => f.endsWith(".md")).sort();
const rows = [];
const records = [];

for (const f of files) {
  const text = readFileSync(join(ISSUES_DIR, f), "utf8");
  const { fm, body } = parseFrontmatter(text);
  const labels = Array.isArray(fm.labels) ? fm.labels : [];
  records.push({ file: f, title: fm.title, milestone: fm.milestone, labels, body, estimate: fm.estimate });
  rows.push({
    Title: fm.title,
    Body: body,
    Labels: labels.join(","),
    Milestone: fm.milestone,
    Assignees: "",
    Status: "Todo",
    Priority: priorityOf(labels),
    Estimate: fm.estimate ?? "",
  });
}

// CSV
const header = ["Title", "Body", "Labels", "Milestone", "Assignees", "Status", "Priority", "Estimate"];
const csv = [header.join(",")];
for (const r of rows) csv.push(header.map(h => csvEscape(r[h])).join(","));
writeFileSync(CSV_PATH, csv.join("\n") + "\n");

console.log(`Wrote ${CSV_PATH} (${rows.length} rows + header)`);
console.log(`Records prepared for bash script: ${records.length}`);
