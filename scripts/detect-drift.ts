import { execSync } from "child_process";
import { Octokit } from "@octokit/rest";

const DEVIN_API_URL = "https://api.devin.ai/v1/sessions";
const DIFF_PATHS = [
  "backend/app/api/",
  "backend/app/models.py",
  "backend/app/crud.py",
  "backend/app/core/",
];

const API_CHANGE_PATTERNS: RegExp[] = [
  /^[+-]\s*@router\.(get|post|put|delete|patch|options|head)\b/,
  /^[+-]\s*(?:async\s+)?def\s+\w+\s*\(/,
  /^[+-]\s*class\s+\w+\s*\(/,
  /^[+-]\s*\w+\s*:\s*(?:str|int|float|bool|list|dict|Optional|List|Dict|UUID|EmailStr)/i,
  /^[+-]\s*response_model\s*=/,
  /^[+-]\s*status_code\s*=/,
  /^[+-]\s*dependencies\s*=/,
  /^[+-]\s*tags\s*=/,
  /^[+-]\s*router\.include_router\b/,
  /^[+-]\s*(?:app|router)\.add_api_route\b/,
  /^[+-]\s*Depends\s*\(/,
  /^[+-]\s*(?:Query|Path|Body|Header|Cookie|Form|File)\s*\(/,
  /^[+-]\s*HTTPException\b/,
];

function getDiff(): string {
  try {
    execSync("git rev-parse HEAD~1", { stdio: "pipe" });
  } catch {
    console.log("HEAD~1 does not exist (likely first commit). Skipping drift detection.");
    process.exit(0);
  }

  const paths = DIFF_PATHS.join(" ");
  try {
    const diff = execSync(`git diff HEAD~1 HEAD -- ${paths}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return diff;
  } catch (err) {
    console.error("Failed to run git diff:", err);
    process.exit(1);
  }
}

function getCommitInfo(): { sha: string; message: string } {
  const sha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const message = execSync("git log -1 --pretty=%B", { encoding: "utf-8" }).trim();
  return { sha, message };
}

interface DriftResult {
  hasApiDrift: boolean;
  changedFiles: string[];
  changes: string[];
}

function parseDiff(diff: string): DriftResult {
  if (!diff.trim()) {
    return { hasApiDrift: false, changedFiles: [], changes: [] };
  }

  const changedFiles: Set<string> = new Set();
  const changes: string[] = [];
  let currentFile = "";

  const lines = diff.split("\n");

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      continue;
    }

    if (!line.startsWith("+") && !line.startsWith("-")) {
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    for (const pattern of API_CHANGE_PATTERNS) {
      if (pattern.test(line)) {
        changedFiles.add(currentFile);
        changes.push(`[${currentFile}] ${line.trim()}`);
        break;
      }
    }
  }

  return {
    hasApiDrift: changes.length > 0,
    changedFiles: Array.from(changedFiles),
    changes,
  };
}

function buildDevinPrompt(diff: string, sha: string, commitMessage: string, drift: DriftResult): string {
  const repoUrl = `https://github.com/${process.env.REPO_OWNER}/${process.env.REPO_NAME}`;
  const commitUrl = `${repoUrl}/commit/${sha}`;
  const shortSha = sha.substring(0, 7);

  return [
    `## Task: Analyze API code changes and update documentation across GitHub, Notion, Slack, and Linear`,
    ``,
    `### Context`,
    `A commit just landed on master in ${repoUrl} that changed API-relevant code.`,
    `You need to figure out what changed, update all documentation to match, and route review items to the right places.`,
    ``,
    `### Repository: ${repoUrl}`,
    `Clone the repo and check out the master branch. The relevant commit is ${shortSha}.`,
    ``,
    `### Repository Structure`,
    `This is a FastAPI backend. Here's where things live:`,
    `- \`backend/app/api/routes/\` - Route handlers (login.py, users.py, items.py, private.py, utils.py, webhooks.py)`,
    `- \`backend/app/api/main.py\` - Router registration`,
    `- \`backend/app/api/deps.py\` - FastAPI dependencies (CurrentUser, SessionDep)`,
    `- \`backend/app/models.py\` - SQLModel data models and Pydantic schemas`,
    `- \`backend/app/crud.py\` - CRUD operations`,
    `- \`backend/app/core/security.py\` - JWT auth, password hashing`,
    `- \`backend/app/core/config.py\` - Pydantic Settings`,
    `- \`docs/api/README.md\` - API reference (primary target for updates)`,
    `- All routes are mounted under \`/api/v1/\` prefix`,
    ``,
    `### Step 1: Analyze the Code Changes`,
    ``,
    `The diff and detected changes are provided below. For each change, classify:`,
    `- **What changed**: New endpoint, removed endpoint, modified params, modified response, modified auth, modified errors, new model, modified model`,
    `- **Affected route file**: Which file in backend/app/api/routes/`,
    `- **Confidence level**:`,
    `  - HIGH: Mechanical change clearly visible in the diff (param added/removed, type changed, new decorator, new function)`,
    `  - MEDIUM: Behavior change is clear but doc implications need judgment (e.g., docstring mentions rate limiting but no code enforcement visible)`,
    `  - LOW: Code changed but unclear how it affects the public API (e.g., internal refactor of crud.py that might change error behavior)`,
    ``,
    `### Step 2: Update docs/api/README.md`,
    ``,
    `Read the current \`docs/api/README.md\` and update it:`,
    `- **HIGH confidence**: Directly update the endpoint listing, parameters, and descriptions.`,
    `- **MEDIUM confidence**: Make your best edit but add an HTML comment above it: \`<!-- REVIEW NEEDED: [explanation] -->\``,
    `- **LOW confidence**: Do NOT edit. Note it in the PR description only.`,
    `Also check \`README.md\` and \`backend/README.md\` - if they reference specific endpoints or API behavior that changed, update those too.`,
    ``,
    `### Step 3: Update Notion Documentation`,
    ``,
    `Use your Notion MCP integration to:`,
    `1. Search the Notion workspace for pages related to the changed endpoints (search terms: endpoint path, route group name, "API Documentation")`,
    `2. For matching Notion pages:`,
    `   - HIGH confidence: Update the page content directly. Add a callout: "Auto-updated by Devin on [today's date] based on commit ${shortSha}."`,
    `   - MEDIUM/LOW confidence: Do NOT edit. Add a callout: "This page may be outdated. Recent code changes (${shortSha}) modified [brief summary]. Please review."`,
    `3. The parent "API Docs" page ID is: 30cb1042-bcaf-80cc-b503-c332da7d857a`,
    ``,
    `### Step 4: Open a GitHub PR`,
    ``,
    `- Branch: \`docs/auto-update-from-${shortSha}\``,
    `- PR title: "Docs: update for [1-line summary of what changed]"`,
    `- PR body must include:`,
    `  - Triggered by: commit ${sha}`,
    `  - Changes Detected table: | Change | File | Confidence | Doc Action |`,
    `  - Documentation Updated checklist`,
    `  - Needs Human Review section (for MEDIUM/LOW items)`,
    `  - Notion Pages Affected section`,
    `- Labels: \`documentation\`, \`automated\``,
    `- Additional label: \`high-confidence\` if ALL changes are HIGH, otherwise \`needs-review\``,
    ``,
    `### Step 5: Create Linear Issues (if needed)`,
    ``,
    `Use your Linear MCP integration:`,
    `- If any LOW confidence changes exist, or guide/conceptual sections need rewriting:`,
    `  - Create a Linear issue in the "Documentation" project (ID: 54cd3fd9-7a9f-4d86-a1c6-1cc8994383fc)`,
    `  - Title: "Review docs for [endpoint/feature] after ${shortSha}"`,
    `  - Priority: High if breaking change, Medium otherwise`,
    `  - Label: doc-drift`,
    `- If ALL changes are HIGH confidence and fully handled, skip Linear issue creation.`,
    ``,
    `### Step 6: Post Slack Notification`,
    ``,
    `Use your Slack MCP integration to post to #api-docs-updates (channel ID: C0AFYCA2LTG):`,
    ``,
    `If ALL changes are HIGH confidence:`,
    `"Doc drift detected in commit ${shortSha} ([commit message]). All changes auto-fixed. Doc PR: [PR link]"`,
    ``,
    `If any MEDIUM or LOW confidence changes:`,
    `"Doc drift detected in commit ${shortSha}. [X] changes auto-fixed, [Y] need review. Doc PR: [PR link]. Linear ticket: [ticket link if created]"`,
    ``,
    `### Do NOT`,
    `- Do NOT modify any existing application code`,
    `- Do NOT implement the code changes described in the diff - only update documentation`,
    `- Do NOT hardcode API keys`,
    ``,
    `---`,
    ``,
    `## Commit Info`,
    `- **SHA:** ${sha}`,
    `- **Commit URL:** ${commitUrl}`,
    `- **Message:** ${commitMessage}`,
    ``,
    `## Changed Files`,
    drift.changedFiles.map((f) => `- ${f}`).join("\n"),
    ``,
    `## Detected API Changes`,
    drift.changes.map((c) => `- ${c}`).join("\n"),
    ``,
    `## Full Diff`,
    "```diff",
    diff,
    "```",
  ].join("\n");
}

async function createDevinSession(prompt: string): Promise<{ session_id: string; url: string }> {
  const apiKey = process.env.DEVIN_API_KEY;
  if (!apiKey) {
    throw new Error("DEVIN_API_KEY environment variable is not set");
  }

  const response = await fetch(DEVIN_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      idempotent: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Devin API returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { session_id: string; url: string };
  return data;
}

async function postCommitComment(octokit: Octokit, owner: string, repo: string, sha: string, body: string): Promise<void> {
  await octokit.repos.createCommitComment({
    owner,
    repo,
    commit_sha: sha,
    body,
  });
}

async function main(): Promise<void> {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!owner || !repo) {
    console.error("REPO_OWNER and REPO_NAME environment variables are required");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: githubToken });

  console.log("Running diff analysis...");
  const diff = getDiff();
  const { sha, message: commitMessage } = getCommitInfo();
  const drift = parseDiff(diff);

  if (!drift.hasApiDrift) {
    console.log("No API drift detected. Only non-functional changes found.");
    process.exit(0);
  }

  console.log(`API drift detected in ${drift.changedFiles.length} file(s):`);
  for (const file of drift.changedFiles) {
    console.log(`  - ${file}`);
  }
  console.log(`Total API-relevant changes: ${drift.changes.length}`);

  const prompt = buildDevinPrompt(diff, sha, commitMessage, drift);

  let devinSession: { session_id: string; url: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Creating Devin session (attempt ${attempt})...`);
      devinSession = await createDevinSession(prompt);
      console.log(`Devin session created: ${devinSession.url}`);
      break;
    } catch (err) {
      console.error(`Attempt ${attempt} failed:`, err);
      if (attempt === 1) {
        console.log("Retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  if (devinSession) {
    await postCommitComment(
      octokit,
      owner,
      repo,
      sha,
      `\u{1F50D} API changes detected \u2014 Devin is analyzing doc drift. Session: ${devinSession.url}`,
    );
    console.log("Posted commit comment with Devin session link.");
  } else {
    console.error("Failed to create Devin session after 2 attempts.");
    await postCommitComment(
      octokit,
      owner,
      repo,
      sha,
      "\u26A0\uFE0F Doc drift detection triggered but Devin session creation failed. Manual review recommended.",
    );
    console.log("Posted commit comment about Devin session failure.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
