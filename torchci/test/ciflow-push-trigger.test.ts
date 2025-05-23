import ciflowPushTrigger from "lib/bot/ciflowPushTrigger";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import {
  mockApprovedWorkflowRuns,
  mockHasApprovedWorkflowRun,
  mockPermissions,
} from "./utils";

nock.disableNetConnect();

function mockDeleteLabel(repoFullName: string, number: number, label: string) {
  return nock("https://api.github.com")
    .delete(
      `/repos/${repoFullName}/issues/${number}/labels/${encodeURIComponent(
        label
      )}`
    )
    .reply(200);
}

describe("Push trigger integration tests", () => {
  let probot: Probot;
  beforeEach(() => {
    probot = new Probot({
      githubToken: "test",
      // Disable throttling & retrying requests for easier testing
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    ciflowPushTrigger(probot);
  });

  afterEach(() => {
    const pendingMocks = nock.pendingMocks();
    if (pendingMocks.length > 0) {
      console.error("pending mocks: %j", nock.pendingMocks());
    }
    expect(nock.isDone()).toBe(true);
    nock.cleanAll();
  });

  test("CIFlow label trigger ignores closed PR", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "closed";
    payload.label.name = "ciflow/test";

    // no requests should be made
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("CIFlow label triggers tag push to head sha", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/trunk";
    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/trunk" ]}')
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [])
      .get("/repos/suo/actions-test/collaborators/suo/permission")
      .reply(200, { permission: "admin" });

    nock("https://api.github.com")
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("non-CIFlow label issues no requests", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    // Change the label to something irrelevant
    payload.label.name = "skipped";

    // No requests should be made.
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("already existing tag should cause tag delete and re-push", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.label.name = "ciflow/trunk";
    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/trunk" ]}')
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [
        {
          ref: `refs/tags/${label}/${prNum}`,
          node_id: "123",
          object: { sha: "abc" },
        },
      ])
      .get("/repos/suo/actions-test/collaborators/suo/permission")
      .reply(200, { permission: "admin" });

    nock("https://api.github.com")
      .delete(
        `/repos/suo/actions-test/git/refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200);

    nock("https://api.github.com")
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("unlabel of CIFlow label should cause tag deletion", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.unlabeled");
    payload.label.name = "ciflow/trunk";

    const label = payload.label.name;
    const prNum = payload.pull_request.number;

    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [
        {
          ref: `refs/tags/${label}/${prNum}`,
          node_id: "123",
          object: { sha: "abc" },
        },
      ]);

    nock("https://api.github.com")
      .delete(
        `/repos/suo/actions-test/git/refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("unlabel of non-CIFlow label should do nothing", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.unlabeled");
    payload.label.name = "foobar";

    // no API requests should be made
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("synchronization of PR should cause all tags to update", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.synchronize");
    const prNum = payload.pull_request.number;
    const labels = [
      "ciflow/test",
      /* payload has "unrelated" label which should be skipped */
      "ciflow/1",
    ];

    mockHasApprovedWorkflowRun(payload.repository.full_name);

    for (const label of labels) {
      nock("https://api.github.com")
        .get(
          `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200, [
          {
            ref: `refs/tags/${label}/${prNum}`,
            node_id: "123",
            object: { sha: "abc" },
          },
        ]);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .delete(
          `/repos/suo/actions-test/git/refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .post("/repos/suo/actions-test/git/refs", (body) => {
          expect(body).toMatchObject({
            ref: `refs/tags/${label}/${prNum}`,
            sha: payload.pull_request.head.sha,
          });
          return true;
        })
        .reply(200);
    }
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("synchronization of PR requires permissions", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.synchronize");
    mockApprovedWorkflowRuns(
      payload.repository.full_name,
      payload.pull_request.head.sha,
      false
    );
    mockPermissions(
      payload.repository.full_name,
      payload.pull_request.user.login,
      "read"
    );
    mockDeleteLabel(
      payload.repository.full_name,
      payload.pull_request.number,
      "ciflow/test"
    );
    mockDeleteLabel(
      payload.repository.full_name,
      payload.pull_request.number,
      "ciflow/1"
    );
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("closure of PR should cause all tags to be removed", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.closed");
    const prNum = payload.pull_request.number;
    const labels = [
      "ciflow/test",
      /* payload has "unrelated" label which should be skipped */
      "ciflow/1",
    ];
    for (const label of labels) {
      nock("https://api.github.com")
        .get(
          `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200, [
          {
            ref: `refs/tags/${label}/${prNum}`,
            node_id: "123",
            object: { sha: "abc" },
          },
        ]);
    }

    for (const label of labels) {
      nock("https://api.github.com")
        .delete(
          `/repos/suo/actions-test/git/refs/${encodeURIComponent(
            `tags/${label}/${prNum}`
          )}`
        )
        .reply(200);
    }
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Unconfigured CIFlow label creates comment", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";

    payload.label.name = "ciflow/test";
    nock("https://api.github.com")
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" });
    nock("https://api.github.com")
      .get(
        `/repos/suo/.github/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" })
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain(
          "No ciflow labels are configured for this repo."
        );
        return true;
      })
      .reply(200);
    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Invalid CIFlow label with established contributor triggers flow", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    const permission = require("./fixtures/push-trigger/permission");
    const label = payload.label.name;
    const prNum = payload.pull_request.number;
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/test";
    nock("https://api.github.com")
      .get(`/repos/suo/actions-test/collaborators/suo/permission`)
      .reply(200, permission) // note: example response from pytorch not action-test
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/foo" ]}')
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("Unknown label `ciflow/test`.");
        return true;
      })
      .reply(200)
      .get(
        `/repos/suo/actions-test/git/matching-refs/${encodeURIComponent(
          `tags/${label}/${prNum}`
        )}`
      )
      .reply(200, [])
      .post("/repos/suo/actions-test/git/refs", (body) => {
        expect(body).toMatchObject({
          ref: `refs/tags/${label}/${prNum}`,
          sha: payload.pull_request.head.sha,
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });

  test("Invalid CIFlow label with first time contributor creates comment", async () => {
    const payload = require("./fixtures/push-trigger/pull_request.labeled");
    payload.pull_request.state = "open";
    payload.label.name = "ciflow/test";
    payload.pull_request.user.login = "fake_user";
    const login = payload.pull_request.user.login;
    const head_sha = payload.pull_request.head.sha;
    nock("https://api.github.com")
      .get(`/repos/suo/actions-test/actions/runs?head_sha=${head_sha}`)
      .reply(200, {})
      .get(`/repos/suo/actions-test/collaborators/${login}/permission`)
      .reply(200, {
        message: "fake_user is not a user",
        documentation_url:
          "https://docs.github.com/rest/collaborators/collaborators#get-repository-permissions-for-a-user",
      })
      .get(
        `/repos/suo/actions-test/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(200, '{ ciflow_push_tags: ["ciflow/foo" ]}')
      .post("/repos/suo/actions-test/issues/5/comments", (body) => {
        expect(body.body).toContain("Unknown label `ciflow/test`.");
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", id: "123", payload });
  });
});
