import dayjs from "dayjs";
import _ from "lodash";
import { Octokit } from "octokit";
import { IssueData } from "./types";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { isDrCIEnabled, isPyTorchPyTorch } from "./bot/utils";
import { Client } from "@opensearch-project/opensearch";
import { MAX_SIZE, OLDEST_FIRST, querySimilarFailures } from "lib/searchUtils";
import { RecentWorkflowsData } from "lib/types";
import {
  isSameAuthor,
  isSameFailure,
  hasS3Log,
  isFailureFromPrevMergeCommit,
  getPRMergeCommits,
} from "lib/jobUtils";

export const NUM_MINUTES = 30;
export const REPO: string = "pytorch";
export const OWNER: string = "pytorch";
export const DRCI_COMMENT_START = "<!-- drci-comment-start -->\n";
export const OH_URL =
  "https://github.com/pytorch/pytorch/wiki/Dev-Infra-Office-Hours";
export const DOCS_URL = "https://docs-preview.pytorch.org";
export const PYTHON_DOCS_PATH = "index.html";
export const CPP_DOCS_PATH = "cppdocs/index.html";
export const DRCI_COMMENT_END = `\n
This comment was automatically generated by Dr. CI and updates every 15 minutes.
<!-- drci-comment-end -->`;
export const HUD_URL = "https://hud.pytorch.org";
export const BOT_COMMANDS_WIKI_URL =
  "https://github.com/pytorch/pytorch/wiki/Bot-commands";
export const FLAKY_RULES_JSON =
  "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/flaky-rules.json";
export const EXCLUDED_FROM_FLAKINESS = [
  "lint",
  "linux-docs",
  "ghstack-mergeability-check",
  "backwards_compat",
];
// If the base commit is too old, don't query for similar failures because
// it increases the risk of getting misclassification. This guardrail can
// be relaxed once we achieve better accuracy from the log classifier. This
// sets the limit to 7 days
export const MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES = 7 * 24;
// Mapping the job to the list of suppressed labels
export const SUPPRESSED_JOB_BY_LABELS: { [job: string]: string[] } = {
  bc_linter: ["suppress-bc-linter", "suppress-api-compatibility-check"],
};

export function formDrciHeader(
  owner: string,
  repo: string,
  prNum: number
): string {
  // For PyTorch only
  if (isPyTorchPyTorch(owner, repo)) {
    return `## :link: Helpful Links
### :test_tube: See artifacts and rendered test results at [hud.pytorch.org/pr/${prNum}](${HUD_URL}/pr/${prNum})
* :page_facing_up: Preview [Python docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${PYTHON_DOCS_PATH})
* :page_facing_up: Preview [C++ docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${CPP_DOCS_PATH})
* :question: Need help or want to give feedback on the CI? Visit the [bot commands wiki](${BOT_COMMANDS_WIKI_URL}) or our [office hours](${OH_URL})

Note: Links to docs will display an error until the docs builds have been completed.`;
  }

  // For domain libraries
  return `## :link: Helpful Links
### :test_tube: See artifacts and rendered test results at [hud.pytorch.org/pr/${owner}/${repo}/${prNum}](${HUD_URL}/pr/${owner}/${repo}/${prNum})
* :page_facing_up: Preview [Python docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${PYTHON_DOCS_PATH})

Note: Links to docs will display an error until the docs builds have been completed.`;
}

export function formDrciComment(
  pr_num: number,
  owner: string = OWNER,
  repo: string = REPO,
  pr_results: string = "",
  sevs: string = ""
): string {
  const header = formDrciHeader(owner, repo, pr_num);
  const comment = `${DRCI_COMMENT_START}
${header}
${sevs}
${pr_results}
${DRCI_COMMENT_END}`;
  return comment;
}

export async function getDrciComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNum: number
): Promise<{ id: number; body: string }> {
  const commentsRes = await octokit.rest.issues.listComments({
    owner: owner,
    repo: repo,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(DRCI_COMMENT_START)) {
      return { id: comment.id, body: comment.body! };
    }
  }
  return { id: 0, body: "" };
}

export function getActiveSEVs(issues: IssueData[]): [IssueData[], IssueData[]] {
  const activeSEVs = issues.filter(
    (issue: IssueData) => issue.state === "open"
  );
  return _.partition(activeSEVs, (issue: IssueData) =>
    issue.body.toLowerCase().includes("merge blocking")
  );
}

export function formDrciSevBody(sevs: [IssueData[], IssueData[]]): string {
  const [mergeBlocking, notMergeBlocking] = sevs;
  if (mergeBlocking.length + notMergeBlocking.length === 0) {
    return "";
  }
  const sev_list = mergeBlocking
    .concat(notMergeBlocking)
    .map(
      (issue: IssueData) =>
        `* ${
          issue.body.toLowerCase().includes("merge blocking")
            ? "(merge blocking) "
            : ""
        }[${issue.title}](${issue.html_url.replace(
          "github.com",
          "hud.pytorch.org"
        )})`
    )
    .join("\n");
  if (mergeBlocking.length > 0) {
    return (
      `## :heavy_exclamation_mark: ${mergeBlocking.length} Merge Blocking SEVs
There is ${mergeBlocking.length} active merge blocking SEVs` +
      (notMergeBlocking.length > 0
        ? ` and ${notMergeBlocking.length} non merge blocking SEVs`
        : "") +
      `.  Please view them below:
${sev_list}\n
If you must merge, use \`@pytorchbot merge -f\`.`
    );
  } else {
    return `## :heavy_exclamation_mark: ${notMergeBlocking.length} Active SEVs
There are ${notMergeBlocking.length} currently active SEVs.   If your PR is affected, please view them below:
${sev_list}\n
`;
  }
}

// The context here is the context from probot.
// Today we only use probot for upserts, but this could later be split into logger
export async function upsertDrCiComment(
  owner: string,
  repo: string,
  prNum: number,
  context: any,
  prUrl: string
) {
  if (!isDrCIEnabled(owner, repo)) {
    context.log(
      `Pull request to ${owner}/${repo} is not supported by Dr.CI bot, no comment is made`
    );
    return;
  }

  const existingDrciData = await getDrciComment(
    context.octokit,
    owner,
    repo,
    prNum
  );
  context.log(
    "Got existing ID: " +
      existingDrciData.id +
      " with body " +
      existingDrciData.body
  );
  const existingDrciID = existingDrciData.id;
  const existingDrciComment = existingDrciData.body;
  const sev = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
  const drciComment = formDrciComment(
    prNum,
    owner,
    repo,
    "",
    formDrciSevBody(sev)
  );

  if (existingDrciComment === drciComment) {
    return;
  }

  if (existingDrciID === 0) {
    await context.octokit.issues.createComment({
      body: drciComment,
      owner: owner,
      repo: repo,
      issue_number: prNum,
    });
    context.log(`Commenting with "${drciComment}" for pull request ${prUrl}`);
  } else {
    context.log({
      body: drciComment,
      owner: owner,
      repo: repo,
      comment_id: existingDrciID,
    });
    await context.octokit.issues.updateComment({
      body: drciComment,
      owner: owner,
      repo: repo,
      comment_id: existingDrciID,
    });
    context.log(
      `Updated comment with "${drciComment}" for pull request ${prUrl}`
    );
  }
}

export async function hasSimilarFailures(
  job: RecentWorkflowsData,
  baseCommitDate: string,
  lookbackPeriodInHours: number = 24,
  client?: Client
): Promise<RecentWorkflowsData | undefined> {
  if (isExcludedFromFlakiness(job)) {
    return;
  }

  // NB: Using the job completed_at timestamp has many false positives, so it's
  // better that we only enable this feature when the head commit timestamp is
  // available and use it as the end date
  if (
    job.head_sha_timestamp === undefined ||
    job.head_sha_timestamp === null ||
    job.head_sha_timestamp === "" ||
    job.head_sha_timestamp === "0"
  ) {
    return;
  }

  // NB: Use the commit timestamp here instead of the job timestamp to avoid using
  // the wrong end date when a PR is reverted and the job reruns
  const endDate = dayjs(job.head_sha_timestamp);
  const startDate = dayjs(
    baseCommitDate !== "" && baseCommitDate !== "0"
      ? baseCommitDate
      : job.head_sha_timestamp
  ).subtract(lookbackPeriodInHours, "hour");

  if (
    endDate.diff(startDate, "hour") >
    MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES
  ) {
    // The base commit is too old, given the current accuracy of the log classifier, it
    // increases the risk of getting an FP when searching for similar failures
    return;
  }

  // NB: It's important to sort the oldest matching results in the search window
  // first here because that can be used to verify if the failure came from one
  // of the previous merge commits of a reverted PR. The first record is the most
  // relevant one and also the first time the failure is observed in the search
  // window
  const records = await querySimilarFailures({
    failure_captures: job.failure_captures,
    name: job.name,
    jobName: job.jobName,
    startDate,
    endDate,
    maxSize: MAX_SIZE,
    sortByTimeStamp: OLDEST_FIRST,
    client,
  });

  if (records.length === 0) {
    return;
  }

  // Find the merge commits of the PR if it has already been merged before
  const mergeCommits = await getPRMergeCommits(job);

  for (const record of records) {
    // Convert the result in JobData to RecentWorkflowsData used by Dr.CI
    const failure: RecentWorkflowsData = {
      workflowId: record.workflowId,
      id: record.id as string,
      jobName: record.jobName as string,
      name: record.name as string,
      conclusion: record.conclusion as string,
      completed_at: record.time as string,
      html_url: record.htmlUrl as string,
      head_sha: record.sha as string,
      head_branch: record.branch as string,
      failure_captures: record.failureCaptures as string[],
      failure_lines: record.failureLines,
      failure_context: record.failureContext,
      authorEmail: record.authorEmail,
    };

    // When a PR is committed, it could break trunk even when the PR was ok due to
    // land race or no signal, i.e. lacking periodic jobs. The SOP is to revert the
    // offending PR and reland it.
    //
    // The problem here w.r.t reverted PR and detecting similar failures is that
    // legit failures from the reverted PR could find similar failures from trunk.
    //
    // The fix here is to do another round of verification for the reverted PR in
    // which its flaky failures is double checked that they didn't appear in trunk
    // for the first time in a reverted merge commit of the same PR
    if (isFailureFromPrevMergeCommit(failure, mergeCommits)) {
      return;
    }

    // Only count different jobs with the same failure. To avoid FP, PRs from the
    // same author are treated as the same till we could figure out a better way
    // to separate them
    if (
      job.id !== failure.id &&
      job.head_sha !== failure.head_sha &&
      job.head_branch !== failure.head_branch &&
      isSameFailure(job, failure) &&
      // Run this check last because it costs one query to query for the commit
      // author of the failure
      !(await isSameAuthor(job, failure))
    ) {
      return failure;
    }
  }

  return;
}

export function isInfraFlakyJob(job: RecentWorkflowsData): boolean {
  // An infra flaky job is a failed job without any failure line and runner. It shows
  // up as an empty job without any logs on GitHub. The failure can only be seen via
  // the workflow summary tab.
  //
  // Also having a workflow ID means that this is a workflow job, not a workflow run.
  // This is to prevent the case where GitHub failed to run the whole workflow, but
  // was allowed to go through as flaky
  return (
    job.conclusion === "failure" &&
    job.workflowId !== null &&
    job.workflowId !== undefined &&
    (job.failure_lines === null ||
      job.failure_lines === undefined ||
      job.failure_lines.join("") === "") &&
    (job.runnerName === null ||
      job.runnerName === undefined ||
      job.runnerName === "")
  );
}

export async function isLogClassifierFailed(
  job: RecentWorkflowsData
): Promise<boolean> {
  // Having no workflow ID means that this is a workflow run, not a workflow job.
  // We don't want to apply the log classifier check for a workflow run
  if (job.workflowId === null || job.workflowId === undefined) {
    return false;
  }

  // This covers the case when there is no log on S3 or log classifier fails to triggered
  const hasFailureLines =
    job.failure_lines !== null &&
    job.failure_lines !== undefined &&
    job.failure_lines.join("") !== "";
  const hasLog = await hasS3Log(job);

  return job.conclusion === "failure" && (!hasFailureLines || !hasLog);
}

export function isExcludedFromFlakiness(job: RecentWorkflowsData): boolean {
  // Lintrunner job are generally stable and should be excluded from flakiness
  // detection
  return (
    _.find(
      EXCLUDED_FROM_FLAKINESS,
      (exclude: string) =>
        job.name !== undefined && job.name.toLowerCase().includes(exclude)
    ) !== undefined
  );
}

export async function fetchIssueLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string[]> {
  const res = await octokit.rest.issues.listLabelsOnIssue({
    owner: owner,
    repo: repo,
    issue_number: issueNumber,
  });

  if (res.data === undefined || res.data == null) {
    return [];
  }

  return _.map(res.data, (label) => label.name);
}

export function getSuppressedLabels(
  job: RecentWorkflowsData,
  labels: string[]
): string[] {
  if (
    job.jobName === undefined ||
    job.jobName === null ||
    !(job.jobName in SUPPRESSED_JOB_BY_LABELS)
  ) {
    return [];
  }

  return _.intersection(SUPPRESSED_JOB_BY_LABELS[job.jobName], labels);
}
