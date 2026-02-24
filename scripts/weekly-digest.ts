import { Octokit } from "@octokit/rest";

const REPO_OWNER = process.env.REPO_OWNER || "SorenSutaria7";
const REPO_NAME = process.env.REPO_NAME || "full-stack-fastapi-template";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

interface DocPR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  labels: string[];
  branch: string;
  body: string;
  confidence: "high-confidence" | "needs-review" | "unknown";
  triggeringCommit: string | null;
  docFilesChanged: string[];
  notionPages: string[];
  highCount: number;
  mediumCount: number;
  lowCount: number;
  closedReason: string;
}

interface DigestData {
  weekStart: string;
  weekEnd: string;
  prs: DocPR[];
  merged: DocPR[];
  open: DocPR[];
  closed: DocPR[];
  totalChanges: number;
  notionUpdated: number;
  notionFlagged: number;
}

function getDateRange(): { since: string; until: string; weekStart: string; weekEnd: string } {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const formatDate = (d: Date): string =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return {
    since: sevenDaysAgo.toISOString(),
    until: now.toISOString(),
    weekStart: formatDate(sevenDaysAgo),
    weekEnd: formatDate(now),
  };
}

function parseConfidenceCounts(body: string): { high: number; medium: number; low: number } {
  let high = 0;
  let medium = 0;
  let low = 0;

  const tableRows = body.match(/\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|/g) || [];
  for (const row of tableRows) {
    const lower = row.toLowerCase();
    if (lower.includes("high") && !lower.includes("change") && !lower.includes("---")) high++;
    if (lower.includes("medium")) medium++;
    if (lower.includes("low") && !lower.includes("---")) low++;
  }

  return { high, medium, low };
}

function parseTriggeringCommit(body: string): string | null {
  const commitMatch = body.match(/\*\*Triggered by:\*\*\s*commit\s+([a-f0-9]+)/i);
  if (commitMatch) return commitMatch[1];

  const shaMatch = body.match(/commit\s+([a-f0-9]{7,40})/i);
  return shaMatch ? shaMatch[1] : null;
}

function parseDocFiles(body: string): string[] {
  const files: string[] = [];
  const fileMatches = body.match(/`(docs\/[^`]+|README\.md|backend\/README\.md)`/g) || [];
  for (const m of fileMatches) {
    const clean = m.replace(/`/g, "");
    if (!files.includes(clean)) files.push(clean);
  }
  return files;
}

function parseNotionPages(body: string): string[] {
  const pages: string[] = [];
  const notionMatches = body.match(/Notion[^)]*\([^)]+notion\.so[^)]+\)/g) || [];
  for (const m of notionMatches) {
    if (!pages.includes(m)) pages.push(m);
  }
  const urlMatches = body.match(/https:\/\/www\.notion\.so\/[^\s)]+/g) || [];
  for (const u of urlMatches) {
    if (!pages.includes(u)) pages.push(u);
  }
  return pages;
}

function parseClosedReason(body: string, comments: string[]): string {
  for (const c of comments) {
    const lower = c.toLowerCase();
    if (lower.includes("consolidat")) return "Consolidated into weekly PR";
    if (lower.includes("revert")) return "Reverted";
    if (lower.includes("duplicate")) return "Duplicate";
    if (lower.includes("incorrect") || lower.includes("wrong")) return "Incorrect changes";
  }
  return "Closed without merge";
}

async function collectDocPRs(): Promise<DocPR[]> {
  const { since } = getDateRange();
  const prs: DocPR[] = [];

  const { data: allPRs } = await octokit.pulls.list({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: 100,
  });

  const docPRs = allPRs.filter((pr) => {
    const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name || ""));
    const hasDoc = labels.includes("documentation");
    const hasAutomated = labels.includes("automated");
    const createdAfter = new Date(pr.created_at) >= new Date(since);
    return (hasDoc && hasAutomated) || (createdAfter && pr.title.toLowerCase().includes("doc"));
  });

  for (const pr of docPRs) {
    const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name || ""));
    const body = pr.body || "";
    const counts = parseConfidenceCounts(body);

    let comments: string[] = [];
    try {
      const { data: prComments } = await octokit.issues.listComments({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: pr.number,
      });
      comments = prComments.map((c) => c.body || "");
    } catch {
      // ignore comment fetch errors
    }

    let state: "open" | "closed" | "merged" = "open";
    if (pr.merged_at) {
      state = "merged";
    } else if (pr.state === "closed") {
      state = "closed";
    }

    let confidence: "high-confidence" | "needs-review" | "unknown" = "unknown";
    if (labels.includes("high-confidence")) confidence = "high-confidence";
    else if (labels.includes("needs-review")) confidence = "needs-review";

    prs.push({
      number: pr.number,
      title: pr.title,
      state,
      url: pr.html_url,
      createdAt: pr.created_at,
      mergedAt: pr.merged_at || null,
      closedAt: pr.closed_at || null,
      labels,
      branch: pr.head.ref,
      body,
      confidence,
      triggeringCommit: parseTriggeringCommit(body),
      docFilesChanged: parseDocFiles(body),
      notionPages: parseNotionPages(body),
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      closedReason: state === "closed" ? parseClosedReason(body, comments) : "",
    });
  }

  return prs;
}

async function consolidateOpenPRs(openPRs: DocPR[]): Promise<DocPR | null> {
  const highConfPRs = openPRs.filter((pr) => pr.confidence === "high-confidence");

  if (highConfPRs.length < 3) {
    console.log(
      `Only ${highConfPRs.length} high-confidence open PRs (need 3+). Skipping consolidation.`
    );
    return null;
  }

  const allFiles = highConfPRs.flatMap((pr) => pr.docFilesChanged);
  const uniqueFiles = [...new Set(allFiles)];
  if (uniqueFiles.length < allFiles.length) {
    console.log("Some PRs touch overlapping files. Skipping consolidation to avoid conflicts.");
    return null;
  }

  const { weekStart, weekEnd } = getDateRange();
  const datePart = new Date().toISOString().split("T")[0];
  const consolBranch = `docs/weekly-consolidation-${datePart}`;

  try {
    const { data: masterRef } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: "heads/master",
    });

    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${consolBranch}`,
      sha: masterRef.object.sha,
    });

    for (const pr of highConfPRs) {
      try {
        await octokit.repos.merge({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          base: consolBranch,
          head: pr.branch,
          commit_message: `Consolidate: ${pr.title} (#${pr.number})`,
        });
      } catch (mergeErr: unknown) {
        const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        console.log(`Merge conflict with PR #${pr.number}: ${errMsg}. Aborting consolidation.`);
        try {
          await octokit.git.deleteRef({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            ref: `heads/${consolBranch}`,
          });
        } catch {
          // cleanup best-effort
        }
        return null;
      }
    }

    const combinedBody = highConfPRs
      .map((pr) => `### From PR #${pr.number}: ${pr.title}\n${pr.body}`)
      .join("\n\n---\n\n");

    const { data: consolPR } = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: `📄 Weekly docs consolidation — ${weekStart} to ${weekEnd}`,
      body: `## 📦 Consolidated Doc Updates\n\nThis PR consolidates ${highConfPRs.length} high-confidence doc PRs from this week.\n\n### Individual PRs included:\n${highConfPRs.map((pr) => `- #${pr.number}: ${pr.title}`).join("\n")}\n\n---\n\n${combinedBody}`,
      head: consolBranch,
      base: "master",
    });

    try {
      await octokit.issues.addLabels({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: consolPR.number,
        labels: ["documentation", "automated", "consolidated"],
      });
    } catch {
      // label creation may fail if labels don't exist
    }

    for (const pr of highConfPRs) {
      await octokit.issues.createComment({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: pr.number,
        body: `Consolidated into ${consolPR.html_url} for easier review.`,
      });

      await octokit.pulls.update({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number: pr.number,
        state: "closed",
      });
    }

    console.log(`Created consolidated PR #${consolPR.number}: ${consolPR.html_url}`);

    return {
      number: consolPR.number,
      title: consolPR.title,
      state: "open",
      url: consolPR.html_url,
      createdAt: consolPR.created_at,
      mergedAt: null,
      closedAt: null,
      labels: ["documentation", "automated", "consolidated"],
      branch: consolBranch,
      body: consolPR.body || "",
      confidence: "high-confidence",
      triggeringCommit: null,
      docFilesChanged: uniqueFiles,
      notionPages: highConfPRs.flatMap((pr) => pr.notionPages),
      highCount: highConfPRs.reduce((sum, pr) => sum + pr.highCount, 0),
      mediumCount: 0,
      lowCount: 0,
      closedReason: "",
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`Consolidation failed: ${errMsg}`);
    return null;
  }
}

function generateSlackMessage(digest: DigestData, consolidatedPR: DocPR | null): string {
  const lines: string[] = [];
  lines.push(
    `📊 *Weekly API Docs Digest — ${digest.weekStart} to ${digest.weekEnd}*`
  );
  lines.push("");

  const uniqueCommits = new Set(digest.prs.map((pr) => pr.triggeringCommit).filter(Boolean));
  lines.push(
    `*${digest.totalChanges} API changes detected across ${uniqueCommits.size || digest.prs.length} commits*`
  );
  lines.push("");

  if (digest.merged.length > 0) {
    lines.push(`✅ *Auto-fixed (${digest.merged.length}):*`);
    for (const pr of digest.merged) {
      lines.push(`  • ${pr.title} (<${pr.url}|PR #${pr.number}>)`);
    }
    lines.push("");
  }

  if (digest.open.length > 0) {
    lines.push(`👀 *Needs review (${digest.open.length}):*`);
    for (const pr of digest.open) {
      lines.push(`  • ${pr.title} → <${pr.url}|PR #${pr.number}>`);
    }
    lines.push("");
  }

  if (digest.closed.length > 0) {
    lines.push(`❌ *Rejected (${digest.closed.length}):*`);
    for (const pr of digest.closed) {
      lines.push(`  • ${pr.title} — ${pr.closedReason}`);
    }
    lines.push("");
  }

  lines.push(
    `📓 *Notion:* ${digest.notionUpdated} pages auto-updated, ${digest.notionFlagged} pages flagged for review`
  );
  lines.push("");

  if (consolidatedPR) {
    lines.push(
      `🔗 *Consolidated PR:* <${consolidatedPR.url}|#${consolidatedPR.number}> — review ${consolidatedPR.docFilesChanged.length} updates in one place`
    );
  }

  return lines.join("\n");
}

function generateNotionDashboard(digest: DigestData): string {
  const totalHigh = digest.prs.reduce((sum, pr) => sum + pr.highCount, 0);
  const totalMedium = digest.prs.reduce((sum, pr) => sum + pr.mediumCount, 0);

  const avgReviewDays =
    digest.merged.length > 0
      ? (
          digest.merged.reduce((sum, pr) => {
            const created = new Date(pr.createdAt).getTime();
            const merged = new Date(pr.mergedAt || pr.createdAt).getTime();
            return sum + (merged - created) / (1000 * 60 * 60 * 24);
          }, 0) / digest.merged.length
        ).toFixed(1)
      : "N/A";

  const lines: string[] = [];
  lines.push(
    `> Auto-updated by Devin weekly digest on ${new Date().toISOString().split("T")[0]}.`
  );
  lines.push("");
  lines.push("# Doc Drift Dashboard");
  lines.push("");
  lines.push("## Weekly Summary");
  lines.push("");
  lines.push("| Week | Changes Detected | Auto-Fixed | Needs Review | Avg Review Time |");
  lines.push("|------|-----------------|------------|-------------|-----------------|");
  lines.push(
    `| ${digest.weekStart} – ${digest.weekEnd} | ${digest.totalChanges} | ${digest.merged.length} | ${digest.open.length} | ${avgReviewDays} days |`
  );
  lines.push("");
  lines.push("## Confidence Breakdown");
  lines.push("");
  lines.push(`- HIGH confidence changes: ${totalHigh}`);
  lines.push(`- MEDIUM confidence changes: ${totalMedium}`);
  lines.push("");
  lines.push("## Current Open Items");
  lines.push("");
  lines.push(`- ${digest.open.length} open doc PRs awaiting review`);
  lines.push(`- ${digest.notionFlagged} Notion pages flagged for review`);
  lines.push("");
  lines.push("## Recent Doc PRs");
  lines.push("");

  for (const pr of digest.prs) {
    const icon = pr.state === "merged" ? "✅" : pr.state === "open" ? "👀" : "❌";
    lines.push(`- ${icon} PR #${pr.number}: ${pr.title} (${pr.state})`);
  }

  return lines.join("\n");
}

function generateGitHubSummary(digest: DigestData, consolidatedPR: DocPR | null): string {
  const lines: string[] = [];
  lines.push("## 📊 Weekly Doc Drift Digest");
  lines.push("");
  lines.push(`**Period:** ${digest.weekStart} — ${digest.weekEnd}`);
  lines.push("");
  lines.push("### Summary");
  lines.push(`- **Total changes detected:** ${digest.totalChanges}`);
  lines.push(`- **Auto-fixed and merged:** ${digest.merged.length}`);
  lines.push(`- **Awaiting review:** ${digest.open.length}`);
  lines.push(`- **Rejected/closed:** ${digest.closed.length}`);
  lines.push("");

  if (digest.prs.length > 0) {
    lines.push("### Doc PRs This Week");
    lines.push("| PR | Status | Confidence | Triggering Commit |");
    lines.push("|-----|--------|------------|-------------------|");
    for (const pr of digest.prs) {
      lines.push(
        `| [#${pr.number}](${pr.url}) ${pr.title} | ${pr.state} | ${pr.confidence} | ${pr.triggeringCommit || "N/A"} |`
      );
    }
    lines.push("");
  }

  if (consolidatedPR) {
    lines.push(
      `### Consolidated PR\n[#${consolidatedPR.number}](${consolidatedPR.url}) — ${consolidatedPR.title}`
    );
    lines.push("");
  }

  return lines.join("\n");
}

async function postGitHubSummary(summary: string): Promise<void> {
  const { data: runs } = await octokit.actions.listWorkflowRuns({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    workflow_id: "doc-digest-weekly.yml",
    per_page: 1,
  });

  if (runs.workflow_runs.length > 0) {
    console.log("GitHub Actions summary generated (would be posted as job summary).");
  }

  console.log("\n=== GITHUB SUMMARY ===\n");
  console.log(summary);
}

async function main(): Promise<void> {
  console.log("=== Weekly Doc Drift Digest ===\n");

  const { weekStart, weekEnd } = getDateRange();
  console.log(`Period: ${weekStart} to ${weekEnd}\n`);

  console.log("Step 1: Collecting doc PRs...");
  const prs = await collectDocPRs();
  console.log(`Found ${prs.length} doc PRs in the last 7 days.\n`);

  const merged = prs.filter((pr) => pr.state === "merged");
  const open = prs.filter((pr) => pr.state === "open");
  const closed = prs.filter((pr) => pr.state === "closed");

  console.log(`  Merged: ${merged.length}`);
  console.log(`  Open: ${open.length}`);
  console.log(`  Closed: ${closed.length}\n`);

  console.log("Step 2: Checking for PR consolidation...");
  const consolidatedPR = await consolidateOpenPRs(open);

  let notionUpdated = 0;
  let notionFlagged = 0;
  for (const pr of prs) {
    if (pr.state === "merged") notionUpdated += pr.notionPages.length;
    else notionFlagged += pr.notionPages.length;
  }

  const totalChanges = prs.reduce(
    (sum, pr) => sum + pr.highCount + pr.mediumCount + pr.lowCount,
    0
  );

  const digest: DigestData = {
    weekStart,
    weekEnd,
    prs,
    merged,
    open: consolidatedPR
      ? open.filter((pr) => pr.confidence !== "high-confidence")
      : open,
    closed: consolidatedPR
      ? [
          ...closed,
          ...open.filter((pr) => pr.confidence === "high-confidence"),
        ]
      : closed,
    totalChanges: totalChanges || prs.length,
    notionUpdated,
    notionFlagged,
  };

  console.log("\nStep 3: Generating Slack message...");
  const slackMessage = generateSlackMessage(digest, consolidatedPR);
  console.log("\n=== SLACK MESSAGE ===\n");
  console.log(slackMessage);

  console.log("\n\nStep 4: Generating Notion dashboard content...");
  const notionContent = generateNotionDashboard(digest);
  console.log("\n=== NOTION DASHBOARD ===\n");
  console.log(notionContent);

  console.log("\n\nStep 5: Generating GitHub summary...");
  const githubSummary = generateGitHubSummary(digest, consolidatedPR);
  await postGitHubSummary(githubSummary);

  const output = {
    slack_message: slackMessage,
    notion_content: notionContent,
    github_summary: githubSummary,
    digest_data: {
      period: `${weekStart} to ${weekEnd}`,
      total_prs: prs.length,
      merged: merged.length,
      open: open.length,
      closed: closed.length,
      total_changes: totalChanges || prs.length,
      consolidated_pr: consolidatedPR
        ? { number: consolidatedPR.number, url: consolidatedPR.url }
        : null,
    },
  };

  const outputPath = process.env.DIGEST_OUTPUT_FILE || "/tmp/digest-output.json";
  const fs = await import("fs");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nDigest output written to ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
