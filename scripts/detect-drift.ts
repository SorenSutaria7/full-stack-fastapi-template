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
  return [
    "[INSERT PHASE 2 PROMPT HERE, with the diff and PR metadata injected]",
    "",
    "## Commit Info",
    `- **SHA:** ${sha}`,
    `- **Message:** ${commitMessage}`,
    "",
    "## Changed Files",
    drift.changedFiles.map((f) => `- ${f}`).join("\n"),
    "",
    "## Detected API Changes",
    drift.changes.map((c) => `- ${c}`).join("\n"),
    "",
    "## Full Diff",
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
